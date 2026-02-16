// doctor subcommand — health checks

import { existsSync, readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BOLD, DIM, RED, GREEN, YELLOW, RESET } from './colors.mjs';
import { runCapture, runSync, commandExists } from './exec.mjs';
import { proxyHealthy } from './proxy.mjs';

export async function doctor(repoDir, dataDir) {
  console.log('');
  console.log(`${BOLD}Moat Doctor${RESET}`);
  console.log('');

  let fails = 0;
  let warns = 0;

  const pass = (msg) => console.log(`  ${GREEN}\u2713${RESET} ${msg}`);
  const warn = (msg) => { console.log(`  ${YELLOW}!${RESET} ${msg}`); warns++; };
  const fail = (msg) => { console.log(`  ${RED}\u2717${RESET} ${msg}`); fails++; };
  const info = (msg) => console.log(`  ${DIM}\u00b7 ${msg}${RESET}`);

  // Symlink check
  const symlinkPath = join(process.env.HOME, '.devcontainers', 'moat');
  try {
    const stat = lstatSync(symlinkPath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(symlinkPath);
      if (target === repoDir) {
        pass(`Symlink ~/.devcontainers/moat -> ${repoDir}`);
      } else {
        warn(`Symlink ~/.devcontainers/moat points to ${target} (expected ${repoDir})`);
      }
    } else if (stat.isDirectory()) {
      warn(`~/.devcontainers/moat is a directory (expected symlink to ${repoDir})`);
    }
  } catch {
    fail('~/.devcontainers/moat not found (run install.sh)');
  }

  // Token in data dir
  const tokenPath = join(dataDir, '.proxy-token');
  if (existsSync(tokenPath)) {
    pass(`Token exists at ${tokenPath}`);
  } else {
    fail(`Token missing at ${tokenPath}`);
  }

  // Token synced to repo
  if (existsSync(join(repoDir, '.proxy-token'))) {
    pass('Token synced to repo dir');
  } else {
    warn('Token not synced to repo dir (will be copied on next build/launch)');
  }

  // docker
  if (commandExists('docker')) {
    pass('docker command found');
  } else {
    fail('docker command not found');
  }

  // node
  if (commandExists('node')) {
    pass('node command found');
  } else {
    fail('node command not found');
  }

  // devcontainer CLI
  if (commandExists('devcontainer')) {
    pass('devcontainer CLI found');
  } else {
    fail('devcontainer CLI not found');
  }

  // Docker daemon
  const dockerInfo = await runCapture('docker', ['info'], { allowFailure: true });
  if (dockerInfo.exitCode === 0) {
    pass('Docker daemon responding');
  } else {
    fail('Docker daemon not responding');
  }

  // Docker image
  const images = await runCapture('docker', ['images', '--format', '{{.Repository}}'], { allowFailure: true });
  if (images.stdout.includes('moat')) {
    pass('Docker image built');
  } else {
    warn("Docker image not found (run 'moat update' to build)");
  }

  // Tool proxy
  if (await proxyHealthy()) {
    info('Tool proxy responding on :9876');
  } else {
    info('Tool proxy not running on :9876 (normal outside sessions)');
  }

  // ANTHROPIC_API_KEY
  if (process.env.ANTHROPIC_API_KEY) {
    pass('ANTHROPIC_API_KEY is set');
  } else {
    fail('ANTHROPIC_API_KEY not set');
  }

  // Mutagen
  if (commandExists('mutagen')) {
    pass("mutagen installed (enables 'moat attach')");
    const syncList = runSync('mutagen sync list --label-selector moat=true');
    if (syncList) {
      const count = (syncList.match(/Name:/g) || []).length;
      if (count > 0) {
        info(`${count} active moat sync session(s)`);
      }
    }
  } else {
    info("mutagen not installed (optional, for 'moat attach' live-sync)");
  }

  console.log('');
  if (fails > 0) {
    console.log(`  ${RED}${BOLD}${fails} fail(s)${RESET}, ${warns} warn(s)`);
    process.exit(1);
  } else if (warns > 0) {
    console.log(`  ${GREEN}${BOLD}All checks passed${RESET}, ${warns} warn(s)`);
  } else {
    console.log(`  ${GREEN}${BOLD}All checks passed${RESET}`);
  }
}
