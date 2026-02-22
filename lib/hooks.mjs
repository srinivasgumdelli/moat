// Refresh hook scripts from repo into container.
// The moat-config volume persists across rebuilds and shadows the Dockerfile COPY,
// so we docker cp the latest hooks on every launch.

import { join } from 'node:path';
import { runCapture } from './exec.mjs';

const HOOKS_DIR = '/home/node/.claude/hooks';

const HOOK_FILES = [
  'statusline.sh',
  'auto-diagnostics.sh',
];

export async function refreshHooks(containerName, repoDir) {
  for (const file of HOOK_FILES) {
    const src = join(repoDir, file);
    const dest = `${containerName}:${HOOKS_DIR}/${file}`;
    try {
      await runCapture('docker', ['cp', src, dest]);
      await runCapture('docker', [
        'exec', containerName,
        'chown', 'node:node', `${HOOKS_DIR}/${file}`,
      ]);
    } catch {
      // Non-fatal — fall back to whatever exists in the volume
    }
  }
}
