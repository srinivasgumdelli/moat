// Forward host MCP server configs into the moat container
// Reads all host config sources, rewrites localhost URLs, merges into container settings

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, DIM, RESET } from './colors.mjs';

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
 */
export function readHostMcpServers() {
  const home = process.env.HOME;
  const claudeDir = join(home, '.claude');
  const sources = [
    join(home, '.claude.json'),
    join(claudeDir, '.claude.json'),
    join(claudeDir, 'settings.json'),
    join(claudeDir, 'settings.local.json'),
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
 * Extract external HTTP MCP servers that should be proxied through tool-proxy.
 * Returns { name: { url, headers } } for non-localhost HTTP servers that have
 * explicit auth headers. Servers without headers (e.g. OAuth-authenticated via
 * Claude Code) are excluded so they connect directly with their own auth.
 */
export function extractHttpMcpServers(mcpServers) {
  const result = {};

  for (const [name, config] of Object.entries(mcpServers)) {
    const url = config?.url;
    if (typeof url !== 'string') continue;

    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      // Skip localhost — already reachable via host.docker.internal rewrite
      if (host === 'localhost' || host === '127.0.0.1') continue;

      // Only proxy servers with explicit auth headers — credential isolation
      // Servers without headers use Claude Code's own OAuth; proxying them
      // strips that auth and breaks the connection.
      if (!config.headers || typeof config.headers !== 'object') continue;
      result[name] = { url, headers: { ...config.headers } };
    } catch {}
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
 * Copy host MCP server configs into the container's settings.json.
 * Accepts pre-read servers map. Filters stdio servers to only those
 * whose command exists in the container. External HTTP servers are
 * rewritten to proxy through tool-proxy (auth stays on host).
 * Non-fatal on any failure.
 *
 * @param {string} containerName
 * @param {object} mcpServers - Host MCP server configs
 * @param {object} [options]
 * @param {string} [options.proxyToken] - Shared secret for tool-proxy auth
 * @param {Set<string>} [options.proxiedServers] - Names of servers being proxied
 */
export async function copyMcpServers(containerName, mcpServers, options = {}) {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return;

  const { proxyToken, proxiedServers } = options;

  // Filter and rewrite
  const filtered = {};
  const skipped = [];

  for (const [name, config] of Object.entries(mcpServers)) {
    if (config?.type === 'url' || config?.url) {
      // External HTTP servers — proxy through tool-proxy if we have a token
      if (proxyToken && proxiedServers?.has(name)) {
        filtered[name] = {
          ...config,
          url: `http://host.docker.internal:9876/mcp/${name}`,
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

  if (Object.keys(filtered).length === 0) return;

  try {
    // Ensure target directory and settings file exist
    await runCapture('docker', [
      'exec', containerName,
      'sh', '-c',
      'mkdir -p /home/node/.claude && [ -f /home/node/.claude/settings.json ] || echo "{}" > /home/node/.claude/settings.json',
    ]);

    // Use jq to do a recursive merge — host servers are added,
    // built-in ones (already filtered out above) are preserved
    const mergeObj = JSON.stringify({ mcpServers: filtered });
    const jqExpr = `. * ${mergeObj}`;
    await runCapture('docker', [
      'exec', containerName,
      'sh', '-c',
      `tmp=$(jq '${jqExpr.replace(/'/g, "'\\''")}' /home/node/.claude/settings.json) && echo "$tmp" > /home/node/.claude/settings.json`,
    ]);

    // Fix ownership
    await runCapture('docker', [
      'exec', containerName,
      'chown', 'node:node', '/home/node/.claude/settings.json',
    ]);

    const names = Object.keys(filtered);
    log(`Forwarded ${names.length} MCP server${names.length === 1 ? '' : 's'} into container ${DIM}(${names.join(', ')})${RESET}`);
  } catch {
    // Non-fatal — just skip
  }
}
