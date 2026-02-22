// update subcommand — pull latest + rebuild image

import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { runInherit, runCapture } from './exec.mjs';
import { log, err, BOLD, YELLOW, RESET } from './colors.mjs';
import { stopProxy } from './proxy.mjs';

export async function update(repoDir, dataDir, args) {
  const forceFlag = args.includes('--force') || args.includes('-f');
  const buildArgs = [];
  if (args[0] === '--version' && args[1]) {
    buildArgs.push('--build-arg', `CLAUDE_CODE_VERSION=${args[1]}`);
    log(`Rebuilding with Claude Code v${args[1]}...`);
  } else {
    log('Pulling latest changes...');
    await runInherit('git', ['-C', repoDir, 'pull', '--ff-only']);
    log('Rebuilding images (no-cache)...');
  }

  // Check for running sessions and warn
  try {
    const result = await runCapture('docker', [
      'ps', '--filter', 'name=moat-', '--format', '{{.Names}}'
    ], { allowFailure: true });
    const containers = result.stdout.trim().split('\n').filter(Boolean);
    if (containers.length > 0 && !forceFlag) {
      console.log('');
      console.log(`${YELLOW}${BOLD}Running moat containers will be stopped:${RESET}`);
      for (const name of containers) {
        console.log(`  ${name}`);
      }
      console.log('');
      const answer = await prompt('Continue? [y/N] ');
      if (answer.toLowerCase() !== 'y') {
        log('Cancelled. Use --force to skip this prompt.');
        process.exit(0);
      }
    }
  } catch {}

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

  // Rebuild devcontainer image
  const exitCode = await runInherit('docker', [
    'compose', '-f', `${repoDir}/docker-compose.yml`,
    'build', '--no-cache', ...buildArgs,
  ]);

  if (exitCode !== 0) {
    err('Devcontainer image build failed');
    process.exit(exitCode);
  }

  // Rebuild agent image
  log('Rebuilding agent image...');
  const agentBuildArgs = ['build', '-t', 'moat-agent', '--no-cache'];
  if (buildArgs.length > 0) {
    agentBuildArgs.push(...buildArgs);
  }
  agentBuildArgs.push('-f', join(repoDir, 'Dockerfile.agent'), repoDir);

  const agentExit = await runInherit('docker', agentBuildArgs);
  if (agentExit !== 0) {
    err('Agent image build failed (non-fatal — agents may not work)');
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

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}
