// Forward host MCP server configs into the moat container
// Reads all host config sources, rewrites localhost URLs, merges into container settings

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, DIM, RESET } from './colors.mjs';
import { PROXY_PORT } from './proxy.mjs';

const BUILTIN_SERVERS = new Set(['ide-tools', 'ide-lsp']);

// Commands commonly available inside the devcontainer
const KNOWN_CONTAINER_COMMANDS = new Set([
  'node', 'npx', 'npm', 'python3', 'python', 'bash', 'sh',
  'uvx', 'uv', 'pip', 'pip3', 'bunx', 'bun', 'deno',
]);

/**
 * Rewrite localhost / 127.0.0.1 URLs to host.docker.internal
 * so host-local HTTP services are reachable from the container.
 */
function rewriteUrls(obj) {
  if (typeof obj === 'string') {
    return obj
      .replace(/\blocalhost\b/g, 'host.docker.internal')
      .replace(/\b127\.0\.0\.1\b/g, 'host.docker.internal');
  }
  if (Array.isArray(obj)) return obj.map(rewriteUrls);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = rewriteUrls(v);
    }
    return out;
  }
  return obj;
}

/**
 * Read MCP servers from a single config file.
 * Returns the mcpServers object or null.
 */
function readMcpFromFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    const servers = data?.mcpServers;
    if (servers && typeof servers === 'object') return servers;
  } catch {}
  return null;
}

/**
 * Read MCP servers from all host config sources.
 * Merges .claude.json, settings.json, and settings.local.json (later wins).
 * Filters out built-in servers. Returns { name: config } map.
 * @param {object} [runtime] — optional runtime config (uses runtime.hostConfigPaths if provided)
 */
export function readHostMcpServers(runtime) {
  const home = process.env.HOME;
  const sources = runtime?.hostConfigPaths
    ? runtime.hostConfigPaths(home)
    : [
        join(home, '.claude.json'),
        join(home, '.claude', '.claude.json'),
        join(home, '.claude', 'settings.json'),
        join(home, '.claude', 'settings.local.json'),
      ];

  const merged = {};
  for (const src of sources) {
    const servers = readMcpFromFile(src);
    if (servers) {
      Object.assign(merged, servers);
    }
  }

  // Filter out built-in servers
  for (const name of BUILTIN_SERVERS) {
    delete merged[name];
  }

  return merged;
}

/**
 * Read the set of MCP server names that have an OAuth token in the host
 * macOS Keychain (`Claude Code-credentials` item, `mcpOAuth` map). Returns
 * null on non-macOS hosts or when the keychain can't be read, signaling
 * "unknown" so callers don't over-filter.
 */
function getKeychainOAuthMcpNames() {
  try {
    const raw = execFileSync('security', [
      'find-generic-password', '-l', 'Claude Code-credentials', '-w',
    ], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const data = JSON.parse(raw);
    const names = new Set();
    for (const key of Object.keys(data.mcpOAuth || {})) {
      names.add(key.split('|')[0]);
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * Extract external HTTP MCP servers that should be proxied through tool-proxy.
 * Returns { name: { url, headers } } for servers with static auth headers, or
 * { name: { url, oauth: true } } for OAuth-authenticated servers — in the
 * latter case tool-proxy reads the access token from the host keychain at
 * request time so credentials never enter the container.
 *
 * OAuth servers without a corresponding keychain entry are skipped entirely
 * (e.g. a stale `mcpServers` entry left behind after the user switched to the
 * claude.ai cloud connector). Skipping them keeps the in-container `/mcp`
 * list free of permanently-failing rows.
 */
export function extractHttpMcpServers(mcpServers) {
  const result = {};
  const oauthNames = getKeychainOAuthMcpNames();
  const skippedOAuth = [];

  for (const [name, config] of Object.entries(mcpServers)) {
    const url = config?.url;
    if (typeof url !== 'string') continue;

    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      // Skip localhost — already reachable via host.docker.internal rewrite
      if (host === 'localhost' || host === '127.0.0.1') continue;

      if (config.headers && typeof config.headers === 'object') {
        result[name] = { url, headers: { ...config.headers } };
      } else if (oauthNames !== null && !oauthNames.has(name)) {
        skippedOAuth.push(name);
      } else {
        result[name] = { url, oauth: true };
      }
    } catch {}
  }

  if (skippedOAuth.length > 0) {
    log(`Skipped ${skippedOAuth.length} OAuth MCP server${skippedOAuth.length === 1 ? '' : 's'} with no host token ${DIM}(${skippedOAuth.join(', ')})${RESET}`);
  }

  return result;
}

/**
 * Extract external hostnames from HTTP-type MCP server URLs.
 * These need to be whitelisted in squid for the sandbox.
 * Skips localhost/127.0.0.1 (already handled via host.docker.internal).
 */
export function extractMcpDomains(mcpServers) {
  const domains = new Set();

  for (const config of Object.values(mcpServers)) {
    const url = config?.url;
    if (typeof url !== 'string') continue;

    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      // Skip localhost — already reachable via host.docker.internal
      if (host === 'localhost' || host === '127.0.0.1') continue;
      domains.add(host);
    } catch {}
  }

  return [...domains];
}

/**
 * Build a shell command that applies a jq expression to a JSON file safely.
 *
 * The naive `tmp=$(jq EXPR f) && printf '%s' "$tmp" > f` pattern has two
 * failure modes, both hit in practice because every session for a workspace
 * shares one /home/node/.claude volume:
 *
 *   1. The `>` redirect truncates the target before the new content lands, so
 *      a concurrent session's jq can read a zero-byte file. jq exits 0 with no
 *      output on empty input, so the `&&` guard passes and the file is written
 *      back empty.
 *   2. An empty (or otherwise invalid) file stays broken forever: the seed
 *      guard only tested for existence, and every later run repeated step 1.
 *
 * This builds the result in a sibling temp file and publishes it with an
 * atomic rename, seeds the target when it is missing/empty/invalid, and
 * refuses to write empty jq output.
 *
 * @param {string} path - Absolute path to the JSON file
 * @param {string} jqExpr - jq filter to apply
 * @param {object} [options]
 * @param {boolean} [options.skipIfMissing] - Succeed without creating the file
 * @returns {string} sh command
 */
export function jqUpdateCommand(path, jqExpr, options = {}) {
  const expr = jqExpr.replace(/'/g, "'\\''");
  const lines = [`f=${path}`];
  if (options.skipIfMissing) lines.push('[ -e "$f" ] || exit 0');
  lines.push(
    `mkdir -p "$(dirname "$f")"`,
    // Seed when missing, empty, or not parseable — otherwise jq has no input
    // and would silently produce nothing.
    `[ -s "$f" ] && jq -e . "$f" >/dev/null 2>&1 || printf '%s' '{}' > "$f"`,
    `t=$(mktemp "$(dirname "$f")/.moat-json.XXXXXX") || exit 1`,
    `if jq '${expr}' "$f" > "$t" && [ -s "$t" ]; then chmod 644 "$t" && mv -f "$t" "$f"; else rm -f "$t"; exit 1; fi`,
  );
  return lines.join('\n');
}

/**
 * Escape raw control characters that appear unescaped inside JSON string
 * literals. Walks byte-by-byte with simple string/escape state tracking.
 * Fast-path returns the input unchanged when it already parses as JSON.
 *
 * Defense-in-depth: if anything (a prior moat version, a third-party tool,
 * an interrupted write) leaves `.claude.json` with raw 0x0A bytes inside
 * strings, the subsequent jq merge would fail. This keeps moat robust to
 * any source of that specific corruption shape.
 */
function sanitizeClaudeJsonString(src) {
  try { JSON.parse(src); return src; } catch {}
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      if (c === '\\' && i + 1 < src.length) {
        out += c + src[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') { inStr = false; out += c; i++; continue; }
      const code = c.charCodeAt(0);
      if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
      else out += c;
      i++;
    } else {
      if (c === '"') inStr = true;
      out += c;
      i++;
    }
  }
  JSON.parse(out); // throws if still invalid — caller decides
  return out;
}

/**
 * Read .claude.json from the container; if it contains raw control chars
 * inside string literals, escape them and write the repaired file back.
 * No-op when the file is already valid JSON or when it doesn't exist.
 */
async function sanitizeContainerClaudeJson(containerName) {
  const path = '/home/node/.claude/.claude.json';
  let raw;
  try {
    const { stdout, exitCode } = await runCapture('docker', [
      'exec', containerName, 'cat', path,
    ], { allowFailure: true });
    if (exitCode !== 0) return;
    raw = stdout;
  } catch { return; }

  let repaired;
  try {
    repaired = sanitizeClaudeJsonString(raw);
  } catch (e) {
    log(`Unable to auto-repair ${path}: ${DIM}${e.message}${RESET}`);
    return;
  }
  if (repaired === raw) return;

  const tmpDir = mkdtempSync(join(tmpdir(), 'moat-sanitize-'));
  const tmpFile = join(tmpDir, 'claude.json');
  try {
    writeFileSync(tmpFile, repaired);
    await runCapture('docker', ['cp', tmpFile, `${containerName}:${path}`]);
    // docker cp places files as root by default. Subsequent jq writes from
    // copyMcpServers run as the default (node) user and would fail; chown back.
    await runCapture('docker', ['exec', '-u', 'root', containerName, 'chown', 'node:node', path]);
    log(`Repaired ${path} ${DIM}(escaped stray control chars inside string values)${RESET}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Copy host MCP server configs into the container's .claude.json.
 * Claude Code reads mcpServers from $CLAUDE_CONFIG_DIR/.claude.json, not
 * settings.json, so that's where the forwarded entries must land. Filters
 * stdio servers to only those whose command exists in the container.
 * External HTTP servers are rewritten to proxy through tool-proxy (auth
 * stays on host). Also clears any stale mcpServers block from settings.json
 * written by older moat versions.
 *
 * Non-fatal on any failure.
 *
 * @param {string} containerName
 * @param {object} mcpServers - Host MCP server configs
 * @param {object} [options]
 * @param {string} [options.proxyToken] - Shared secret for tool-proxy auth
 * @param {Set<string>} [options.proxiedServers] - Names of servers being proxied
 */
export async function copyMcpServers(containerName, mcpServers, options = {}) {
  const servers = mcpServers || {};
  const { proxyToken, proxiedServers } = options;

  // Filter and rewrite
  const filtered = {};
  const skipped = [];

  for (const [name, config] of Object.entries(servers)) {
    if (config?.type === 'url' || config?.url) {
      // External HTTP servers — proxy through tool-proxy if we have a token
      if (proxyToken && proxiedServers?.has(name)) {
        filtered[name] = {
          ...config,
          url: `http://host.docker.internal:${PROXY_PORT}/mcp/${name}`,
          headers: { Authorization: `Bearer ${proxyToken}` },
        };
      } else {
        // Not proxied — strip any auth headers (credentials must stay on host)
        const { headers, ...rest } = config;
        filtered[name] = rewriteUrls(rest);
      }
    } else {
      // stdio servers — only forward if command likely exists in container
      const cmd = config?.command;
      if (cmd && KNOWN_CONTAINER_COMMANDS.has(cmd)) {
        filtered[name] = rewriteUrls(config);
      } else {
        skipped.push(name);
      }
    }
  }

  if (skipped.length > 0) {
    log(`Skipped ${skipped.length} stdio MCP server${skipped.length === 1 ? '' : 's'} (command not in container): ${DIM}${skipped.join(', ')}${RESET}`);
  }

  const claudeJsonPath = '/home/node/.claude/.claude.json';
  const settingsPath = '/home/node/.claude/settings.json';
  const builtinTest = [...BUILTIN_SERVERS].map(k => `.key == ${JSON.stringify(k)}`).join(' or ');
  const mergeObj = JSON.stringify(filtered);
  // Replace mcpServers entirely: preserve built-in servers, add forwarded ones,
  // and remove stale entries from previous runs (jq * merge only adds, never removes)
  const jqExpr = `.mcpServers = ((.mcpServers // {} | to_entries | map(select(${builtinTest})) | from_entries) + ${mergeObj})`;

  try {
    // Defensive: if anything has left .claude.json with raw control chars
    // inside string values, repair before the jq merge (which would otherwise
    // fail). Cheap no-op when the file is already valid.
    await sanitizeContainerClaudeJson(containerName);

    // Normalize ownership to node:node before any jq+redirect writes. The
    // config files can end up owned by the host uid (via bind mounts or past
    // docker cp operations) which blocks the node user from overwriting them.
    await runCapture('docker', [
      'exec', '-u', 'root', containerName,
      'sh', '-c',
      `[ -e ${claudeJsonPath} ] && chown node:node ${claudeJsonPath}; [ -e ${settingsPath} ] && chown node:node ${settingsPath}; true`,
    ]);

    // Ensure built-in MCP scripts (ide-tools, ide-lsp) can resolve
    // @modelcontextprotocol/sdk. The SDK is installed at the global npm prefix,
    // but ESM bare-specifier resolution only walks node_modules parents from
    // the importing file. Symlink the global prefix into .claude/node_modules
    // so `import from '@modelcontextprotocol/sdk/...'` resolves inside the
    // mcp scripts. The moat-config volume hides the image's symlink if any,
    // so we create it on every run (cheap, idempotent).
    await runCapture('docker', [
      'exec', containerName,
      'sh', '-c',
      'ln -sfn /usr/local/share/npm-global/lib/node_modules /home/node/.claude/node_modules',
    ]);

    await runCapture('docker', [
      'exec', containerName,
      'sh', '-c',
      jqUpdateCommand(claudeJsonPath, jqExpr),
    ]);

    // Drop any stale mcpServers block in settings.json (older moat versions
    // wrote here; Claude Code ignores it but we don't want it lingering).
    await runCapture('docker', [
      'exec', containerName,
      'sh', '-c',
      jqUpdateCommand(settingsPath, 'del(.mcpServers)', { skipIfMissing: true }),
    ]);

    await runCapture('docker', [
      'exec', containerName,
      'chown', 'node:node', claudeJsonPath, settingsPath,
    ]);

    const names = Object.keys(filtered);
    if (names.length > 0) {
      log(`Forwarded ${names.length} MCP server${names.length === 1 ? '' : 's'} into container ${DIM}(${names.join(', ')})${RESET}`);
    }
  } catch (e) {
    log(`Failed to forward MCP servers into container: ${DIM}${e.message || e}${RESET}`);
  }
}

/**
 * Merge arbitrary key/value pairs into the container's settings.json.
 * Used to force settings (e.g. permissionMode) that must survive CLI flag bugs.
 *
 * @param {string} containerName
 * @param {object} settings - Key/value pairs to set in settings.json
 */
export async function writeContainerSettings(containerName, settings) {
  try {
    // Flatten nested object into jq path expressions: { a: { b: 1 } } → `.a.b = 1`
    function toPaths(obj, prefix = '') {
      const exprs = [];
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : `.${k}`;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          exprs.push(...toPaths(v, path));
        } else {
          exprs.push(`${path} = ${JSON.stringify(v)}`);
        }
      }
      return exprs;
    }
    const jqExpr = toPaths(settings).join(' | ');
    await runCapture('docker', [
      'exec', containerName,
      'sh', '-c',
      jqUpdateCommand('/home/node/.claude/settings.json', jqExpr),
    ]);

    await runCapture('docker', [
      'exec', containerName,
      'chown', 'node:node', '/home/node/.claude/settings.json',
    ]);
  } catch (e) {
    log(`Failed to write container settings: ${DIM}${e.message || e}${RESET}`);
  }
}

/**
 * Copy host ~/.claude/settings.local.json into the container.
 * This carries over user-level hooks that live in settings.local.json.
 * Non-fatal if the file doesn't exist or the copy fails.
 *
 * @param {string} containerName
 */
export async function copySettingsLocal(containerName) {
  const src = join(process.env.HOME, '.claude', 'settings.local.json');
  if (!existsSync(src)) return;

  try {
    await runCapture('docker', [
      'cp', src,
      `${containerName}:/home/node/.claude/settings.local.json`,
    ]);
    await runCapture('docker', [
      'exec', containerName,
      'chown', 'node:node', '/home/node/.claude/settings.local.json',
    ]);
    log(`Copied host settings.local.json into container ${DIM}(hooks + local overrides)${RESET}`);
  } catch (e) {
    log(`Failed to copy settings.local.json: ${DIM}${e.message || e}${RESET}`);
  }
}
