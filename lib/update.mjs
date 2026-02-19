// update subcommand — pull latest + rebuild image

import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInherit, runCapture } from './exec.mjs';
import { log } from './colors.mjs';
import { stopProxy } from './proxy.mjs';

export async function update(repoDir, dataDir, args) {
  const buildArgs = [];
  if (args[0] === '--version' && args[1]) {
    buildArgs.push('--build-arg', `CLAUDE_CODE_VERSION=${args[1]}`);
    log(`Rebuilding with Claude Code v${args[1]}...`);
  } else {
    log('Pulling latest changes...');
    await runInherit('git', ['-C', repoDir, 'pull', '--ff-only']);
    log('Rebuilding image (no-cache)...');
  }

  // Stop all running moat containers before rebuild
  try {
    const result = await runCapture('docker', [
      'ps', '-a', '--filter', 'name=moat', '--format', '{{.Names}}'
    ], { allowFailure: true });
    const containers = result.stdout.trim().split('\n').filter(Boolean);
    for (const name of containers) {
      await runCapture('docker', ['rm', '-f', name], { allowFailure: true });
    }
  } catch {}

  // Stop tool proxy so it restarts with new code on next launch
  await stopProxy();

  // Copy token after pull
  ensureToken(repoDir, dataDir);

  const exitCode = await runInherit('docker', [
    'compose', '-f', `${repoDir}/docker-compose.yml`,
    'build', '--no-cache', ...buildArgs,
  ]);

  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  log('Update complete.');
}

function ensureToken(repoDir, dataDir) {
  const src = join(dataDir, '.proxy-token');
  const dst = join(repoDir, '.proxy-token');
  if (existsSync(src)) {
    copyFileSync(src, dst);
  }
}
