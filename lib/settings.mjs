// Merge host ~/.claude/settings.json into container settings.
// Moat-managed keys (statusLine, hooks, mcpServers, permissions) are
// preserved from the container; all other host preferences are overlaid.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, DIM, RESET } from './colors.mjs';

const HOST_SETTINGS = join(process.env.HOME, '.claude', 'settings.json');
const CONTAINER_SETTINGS = '/home/node/.claude/settings.json';

// Keys managed by moat — never overwrite from host
const MOAT_KEYS = ['statusLine', 'hooks', 'mcpServers', 'permissions', '$schema'];

/**
 * Merge host global settings into the container's settings.json.
 * Moat-managed keys are always preserved from the container side.
 * @param {string} containerName - Docker container name
 */
export async function copySettings(containerName) {
  if (!existsSync(HOST_SETTINGS)) {
    return;
  }

  try {
    // Copy host settings to temp location in container
    await runCapture('docker', [
      'cp', HOST_SETTINGS, `${containerName}:/tmp/host-settings.json`,
    ]);

    // Merge: container settings as base, overlay host settings minus moat-managed keys
    const deleteExpr = MOAT_KEYS.map(k => `del(.${k})`).join(' | ');
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
  }
}
