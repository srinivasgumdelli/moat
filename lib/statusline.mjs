// Copy statusline scripts (statusline.sh, subagent-statusline.sh) from host
// ~/.claude/ into the container so the statusLine / subagentStatusLine commands
// in host settings.json resolve inside the sandbox.
//
// Path rewriting for the *command* fields in settings.json lives in
// lib/settings.mjs; this module only handles the script payloads themselves.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, err, DIM, RESET } from './colors.mjs';

const HOST_CLAUDE_DIR = join(process.env.HOME, '.claude');
const CONTAINER_CLAUDE_DIR = '/home/node/.claude';

const SCRIPTS = ['statusline.sh', 'subagent-statusline.sh'];

// Remove blocks that don't make sense inside a moat sandbox. Currently: the
// "all-time token total" segment, which reads ~/.claude/.token-totals.cache —
// a file aggregated by the host's SessionStart hook (not forwarded into the
// container) and scoped to the per-workspace moat-config volume anyway.
// Delete from the block-opening comment through the closing `fi`, stopping
// just before the next "# Rate limits" block.
async function stripSandboxIrrelevantBlocks(containerName, scriptPath) {
  const sedExpr = '/^# All-time token total:/,/^# Rate limits/{/^# Rate limits/!d;}';
  await runCapture('docker', [
    'exec', '-u', 'root', containerName,
    'sed', '-i', sedExpr, scriptPath,
  ]);
}

/**
 * Copy host statusline scripts into the container.
 * @param {string} containerName — Docker container name
 */
export async function copyStatusline(containerName) {
  const present = SCRIPTS.filter(s => existsSync(join(HOST_CLAUDE_DIR, s)));
  if (present.length === 0) return;

  try {
    for (const name of present) {
      const hostPath = join(HOST_CLAUDE_DIR, name);
      const containerPath = `${CONTAINER_CLAUDE_DIR}/${name}`;
      await runCapture('docker', [
        'cp', hostPath, `${containerName}:${containerPath}`,
      ]);
      if (name === 'statusline.sh') {
        await stripSandboxIrrelevantBlocks(containerName, containerPath);
      }
      await runCapture('docker', [
        'exec', '-u', 'root', containerName,
        'chown', 'node:node', containerPath,
      ]);
      await runCapture('docker', [
        'exec', '-u', 'root', containerName,
        'chmod', '+x', containerPath,
      ]);
    }
    const plural = present.length === 1 ? '' : 's';
    log(`Copied ${present.length} statusline script${plural} from host ${DIM}(~/.claude)${RESET}`);
  } catch (e) {
    err(`Failed to copy statusline scripts: ${e.result?.stderr?.trim() || e.message}`);
  }
}
