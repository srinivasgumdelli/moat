// update subcommand — pull latest + rebuild image

import { existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInherit } from './exec.mjs';
import { log } from './colors.mjs';
import { composeArgs, teardown } from './container.mjs';

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

  // Stop running containers before rebuild
  await teardown(repoDir);

  // Copy token after pull
  ensureToken(repoDir, dataDir);

  // Ensure services placeholder exists
  const servicesFile = join(repoDir, 'docker-compose.services.yml');
  if (!existsSync(servicesFile)) {
    writeFileSync(servicesFile, 'services:\n  devcontainer: {}\n');
  }

  const exitCode = await runInherit('docker', [
    'compose', ...composeArgs(repoDir),
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
