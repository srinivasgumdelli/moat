// Merge base (baked-in) CLAUDE.md with host user's global CLAUDE.md
// Base is always refreshed from the repo (handles volume persistence across rebuilds),
// then host content is appended with a separator header.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, DIM, RESET } from './colors.mjs';

const BASE_PATH = '/home/node/.claude/CLAUDE.md.base';
const TARGET_PATH = '/home/node/.claude/CLAUDE.md';

/**
 * Copy moat-claude.md into the container as the base, then append host
 * ~/.claude/CLAUDE.md if it exists.
 *
 * The base file is always refreshed from the repo so that image rebuilds
 * take effect even when the moat-config named volume persists.
 */
export async function copyClaudeMd(containerName, repoDir) {
  const baseSrc = join(repoDir, 'moat-claude.md');

  // Refresh .base from the repo (survives volume persistence across rebuilds)
  if (existsSync(baseSrc)) {
    try {
      await runCapture('docker', [
        'cp', baseSrc, `${containerName}:${BASE_PATH}`,
      ]);
      await runCapture('docker', [
        'exec', containerName,
        'chown', 'node:node', BASE_PATH,
      ]);
    } catch {
      // Non-fatal — fall back to whatever .base exists in the volume
    }
  }

  // Restore target from base
  try {
    await runCapture('docker', [
      'exec', containerName,
      'cp', BASE_PATH, TARGET_PATH,
    ]);
  } catch {
    // .base doesn't exist (old image without baked-in rules) — skip
    return;
  }

  const hostPath = join(process.env.HOME, '.claude', 'CLAUDE.md');
  if (!existsSync(hostPath)) {
    log(`Loaded base CLAUDE.md rules ${DIM}(plan-first workflow)${RESET}`);
    return;
  }

  try {
    // Copy host file into container at a temp location
    await runCapture('docker', [
      'cp', hostPath, `${containerName}:/tmp/host-claude.md`,
    ]);

    // Append host content with a separator header
    await runCapture('docker', [
      'exec', containerName,
      'sh', '-c',
      `printf '\\n\\n# User Global Instructions\\n\\n' >> ${TARGET_PATH} && cat /tmp/host-claude.md >> ${TARGET_PATH} && rm -f /tmp/host-claude.md`,
    ]);

    // Fix ownership
    await runCapture('docker', [
      'exec', containerName,
      'chown', 'node:node', TARGET_PATH,
    ]);

    log(`Loaded base CLAUDE.md rules + user global instructions ${DIM}(~/.claude/CLAUDE.md)${RESET}`);
  } catch {
    // Non-fatal — base rules are already in place
  }
}
