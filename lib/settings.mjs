// Merge host ~/.claude/settings.json into container settings.
// Moat-managed keys (hooks, mcpServers, permissions) are preserved from the
// container; all other host preferences are overlaid.
//
// statusLine / subagentStatusLine pass through from the host, but their
// `command` fields reference absolute host paths (e.g. /Users/sri/.claude/...).
// Those get rewritten to the container's equivalent (/home/node/.claude/...)
// so they line up with the scripts copied in by lib/statusline.mjs.

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, DIM, RESET } from './colors.mjs';

const HOST_CLAUDE_DIR = join(process.env.HOME, '.claude');
const HOST_SETTINGS = join(HOST_CLAUDE_DIR, 'settings.json');
const CONTAINER_CLAUDE_DIR = '/home/node/.claude';
const CONTAINER_SETTINGS = `${CONTAINER_CLAUDE_DIR}/settings.json`;

// Keys managed by moat — never overwrite from host
const MOAT_KEYS = ['hooks', 'mcpServers', 'permissions', '$schema'];

function rewriteClaudeHomePath(p) {
  if (typeof p !== 'string') return p;
  if (p === HOST_CLAUDE_DIR) return CONTAINER_CLAUDE_DIR;
  if (p.startsWith(HOST_CLAUDE_DIR + '/')) {
    return CONTAINER_CLAUDE_DIR + p.slice(HOST_CLAUDE_DIR.length);
  }
  return p;
}

function rewriteStatuslinePaths(data) {
  for (const key of ['statusLine', 'subagentStatusLine']) {
    const cmd = data?.[key]?.command;
    if (typeof cmd === 'string') {
      data[key].command = rewriteClaudeHomePath(cmd);
    }
  }
}

/**
 * Merge host global settings into the container's settings.json.
 * Moat-managed keys are always preserved from the container side.
 * @param {string} containerName - Docker container name
 */
export async function copySettings(containerName) {
  if (!existsSync(HOST_SETTINGS)) {
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'moat-settings-'));
  const tmpFile = join(tmpDir, 'host-settings.json');
  try {
    // Pre-rewrite host settings so statusline commands point at container paths.
    const hostData = JSON.parse(readFileSync(HOST_SETTINGS, 'utf8'));
    rewriteStatuslinePaths(hostData);
    writeFileSync(tmpFile, JSON.stringify(hostData));

    await runCapture('docker', [
      'cp', tmpFile, `${containerName}:/tmp/host-settings.json`,
    ]);

    // Merge: container settings as base, overlay host settings minus moat-managed keys.
    // Use bracket-quoted field names so keys like "$schema" don't break jq parsing.
    const deleteExpr = MOAT_KEYS.map(k => `del(.["${k}"])`).join(' | ');
    const mergeScript = `
      .[0] as $container |
      (.[1] | ${deleteExpr}) as $host |
      $container * $host
    `.trim();

    await runCapture('docker', [
      'exec', containerName,
      'sh', '-c',
      `jq -s '${mergeScript}' ${CONTAINER_SETTINGS} /tmp/host-settings.json > /tmp/merged-settings.json && mv /tmp/merged-settings.json ${CONTAINER_SETTINGS} && chown node:node ${CONTAINER_SETTINGS} && rm -f /tmp/host-settings.json`,
    ]);

    log(`Merged host settings ${DIM}(~/.claude/settings.json)${RESET}`);
  } catch {
    // Non-fatal — container defaults are fine
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
