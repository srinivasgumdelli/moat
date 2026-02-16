// Forward host MCP server configs into the moat container
// Reads ~/.claude/settings.json, rewrites localhost URLs, merges into container settings

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, DIM, RESET } from './colors.mjs';

const BUILTIN_SERVERS = new Set(['ide-tools', 'ide-lsp']);

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
 * Copy host MCP server configs into the container's settings.json.
 * Non-fatal on any failure.
 */
export async function copyMcpServers() {
  const settingsPath = join(process.env.HOME, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return;

  let hostSettings;
  try {
    hostSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return;
  }

  const mcpServers = hostSettings?.mcpServers;
  if (!mcpServers || typeof mcpServers !== 'object') return;

  // Filter out built-in servers and rewrite URLs
  const filtered = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    if (BUILTIN_SERVERS.has(name)) continue;
    filtered[name] = rewriteUrls(config);
  }

  if (Object.keys(filtered).length === 0) return;

  try {
    // Ensure target directory and settings file exist
    await runCapture('docker', [
      'exec', 'moat-devcontainer-1',
      'sh', '-c',
      'mkdir -p /home/node/.claude && [ -f /home/node/.claude/settings.json ] || echo "{}" > /home/node/.claude/settings.json',
    ]);

    // Use jq to do a recursive merge — host servers are added,
    // built-in ones (already filtered out above) are preserved
    const mergeObj = JSON.stringify({ mcpServers: filtered });
    const jqExpr = `. * ${mergeObj}`;
    await runCapture('docker', [
      'exec', 'moat-devcontainer-1',
      'sh', '-c',
      `tmp=$(jq '${jqExpr.replace(/'/g, "'\\''")}' /home/node/.claude/settings.json) && echo "$tmp" > /home/node/.claude/settings.json`,
    ]);

    // Fix ownership
    await runCapture('docker', [
      'exec', 'moat-devcontainer-1',
      'chown', 'node:node', '/home/node/.claude/settings.json',
    ]);

    const names = Object.keys(filtered);
    log(`Forwarded ${names.length} MCP server${names.length === 1 ? '' : 's'} into container ${DIM}(${names.join(', ')})${RESET}`);
  } catch {
    // Non-fatal — just skip
  }
}
