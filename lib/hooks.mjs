// Refresh scripts from repo into container on every launch.
// The moat-config volume shadows Dockerfile COPY for hooks, and reused
// containers keep stale /usr/local/bin scripts from old images.

import { join } from 'node:path';
import { runCapture } from './exec.mjs';

const HOOKS_DIR = '/home/node/.claude/hooks';

const HOOK_FILES = [
  'statusline.sh',
  'auto-diagnostics.sh',
];

// Scripts installed to /usr/local/bin (owned by root)
const BIN_FILES = [
  { src: 'agent.sh', dest: '/usr/local/bin/agent' },
];

export async function refreshHooks(containerName, repoDir) {
  // Hooks — owned by node, in the persistent volume
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
      // Non-fatal — fall back to whatever exists in the volume/image
    }
  }

  // Bin scripts — owned by root, in the container filesystem
  for (const { src, dest } of BIN_FILES) {
    try {
      await runCapture('docker', ['cp', join(repoDir, src), `${containerName}:${dest}`]);
      await runCapture('docker', [
        'exec', '-u', 'root', containerName,
        'chmod', '+x', dest,
      ]);
    } catch {
      // Non-fatal
    }
  }
}
