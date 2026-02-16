// Copy global CLAUDE.md into the container
// Uses docker cp — simpler than bind mounts, gracefully handles missing file

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, DIM, RESET } from './colors.mjs';

/**
 * Copy ~/.claude/CLAUDE.md into the moat-devcontainer-1 container.
 * No-op if the file doesn't exist on the host.
 */
export async function copyClaudeMd() {
  const hostPath = join(process.env.HOME, '.claude', 'CLAUDE.md');
  if (!existsSync(hostPath)) return;

  try {
    // Ensure target directory exists
    await runCapture('docker', [
      'exec', 'moat-devcontainer-1',
      'mkdir', '-p', '/home/node/.claude',
    ]);

    // Copy file into container
    await runCapture('docker', [
      'cp', hostPath, 'moat-devcontainer-1:/home/node/.claude/CLAUDE.md',
    ]);

    // Fix ownership
    await runCapture('docker', [
      'exec', 'moat-devcontainer-1',
      'chown', 'node:node', '/home/node/.claude/CLAUDE.md',
    ]);

    log(`Copied global CLAUDE.md into container ${DIM}(~/.claude/CLAUDE.md)${RESET}`);
  } catch {
    // Non-fatal — just skip
  }
}
