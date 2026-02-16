#!/usr/bin/env node
// Moat — sandboxed Claude Code launcher
// Usage: moat [workspace_path] [--add-dir <path>...] [claude args...]
// Subcommands: doctor | update [--version X.Y.Z] | down | attach <dir> | detach <dir|--all> | plan | init | uninstall

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, lstatSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

import { parseArgs } from './lib/cli.mjs';
import { log, err, DIM, RESET } from './lib/colors.mjs';
import { generateProjectConfig, generateExtraDirsYaml } from './lib/compose.mjs';
import { containerRunning, mountsMatch, anyContainerRunning, teardown, startContainer, execClaude } from './lib/container.mjs';
import { startProxy, stopProxySync } from './lib/proxy.mjs';
import { doctor } from './lib/doctor.mjs';
import { update } from './lib/update.mjs';
import { down } from './lib/down.mjs';
import { attach, detach } from './lib/attach.mjs';
import { copyClaudeMd } from './lib/claude-md.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = __dirname;
const DATA_DIR = join(process.env.HOME, '.moat', 'data');
const OVERRIDE_FILE = join(REPO_DIR, 'docker-compose.extra-dirs.yml');
const SERVICES_FILE = join(REPO_DIR, 'docker-compose.services.yml');

// --- Parse arguments ---
let parsed;
try {
  parsed = parseArgs(process.argv);
} catch (e) {
  err(e.message);
  process.exit(1);
}

const { subcommand, subcommandArgs, workspace, extraDirs, claudeArgs } = parsed;

// --- Handle uninstall early ---
if (subcommand === 'uninstall') {
  spawnSync('bash', [join(REPO_DIR, 'uninstall.sh'), ...subcommandArgs], { stdio: 'inherit' });
  process.exit(0);
}

// --- Ensure data directory ---
mkdirSync(DATA_DIR, { recursive: true });

// --- Auto-generate proxy token if missing ---
const tokenPath = join(DATA_DIR, '.proxy-token');
if (!existsSync(tokenPath)) {
  const oldTokenPath = join(process.env.HOME, '.devcontainers', 'moat', '.proxy-token');
  if (existsSync(oldTokenPath)) {
    try {
      // Check it's not a symlink pointing to our repo (avoid copying from symlinked dir)
      const parentStat = lstatSync(join(process.env.HOME, '.devcontainers', 'moat'));
      if (!parentStat.isSymbolicLink()) {
        copyFileSync(oldTokenPath, tokenPath);
        log(`Migrated proxy token to ${tokenPath}`);
      }
    } catch {}
  }
  if (!existsSync(tokenPath)) {
    const token = execSync('openssl rand -hex 32', { encoding: 'utf-8' }).trim();
    writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
    log(`Generated new proxy token at ${tokenPath}`);
  }
}

function ensureTokenInRepo() {
  if (existsSync(tokenPath)) {
    copyFileSync(tokenPath, join(REPO_DIR, '.proxy-token'));
  }
}

// --- Route subcommands ---

if (subcommand === 'doctor') {
  await doctor(REPO_DIR, DATA_DIR);
  process.exit(0);
}

if (subcommand === 'down') {
  await down(REPO_DIR);
  process.exit(0);
}

if (subcommand === 'attach') {
  await attach(REPO_DIR, subcommandArgs);
  process.exit(0);
}

if (subcommand === 'detach') {
  await detach(subcommandArgs);
  process.exit(0);
}

if (subcommand === 'update') {
  await update(REPO_DIR, DATA_DIR, subcommandArgs);
  process.exit(0);
}

if (subcommand === 'init') {
  const { initConfig } = await import('./lib/init-config.mjs');
  await initConfig(workspace);
  process.exit(0);
}

// --- plan subcommand: inject read-only tool restriction ---
if (subcommand === 'plan') {
  claudeArgs.push('--allowedTools', 'Read,Grep,Glob,Task,WebFetch,WebSearch');
}

// --- Main flow ---

process.env.MOAT_WORKSPACE = workspace;

// Generate docker-compose override for extra directories
writeFileSync(OVERRIDE_FILE, generateExtraDirsYaml(extraDirs));

if (extraDirs.length > 0) {
  log('Extra directories:');
  for (const dir of extraDirs) {
    console.log(`  ${DIM}${dir} -> /extra/${basename(dir)}${RESET}`);
  }
}

// Auto-detect dependencies if no .moat.yml exists
if (!existsSync(join(workspace, '.moat.yml'))) {
  const { initConfig } = await import('./lib/init-config.mjs');
  await initConfig(workspace, { auto: true });
}

// Generate per-project config from .moat.yml
const meta = generateProjectConfig(workspace, REPO_DIR);
if (meta.has_services) {
  log(`Project services: ${DIM}${meta.service_names.join(', ')}${RESET}`);
}
if (meta.extra_domains.length > 0) {
  log(`Extra domains: ${DIM}${meta.extra_domains.join(', ')}${RESET}`);
}

// On exit: stop tool proxy, leave containers running for reuse
process.on('exit', () => {
  stopProxySync();
});
process.on('SIGTERM', () => process.exit(0));

// Start or reuse tool proxy
ensureTokenInRepo();
const proxyOk = await startProxy(REPO_DIR, workspace, DATA_DIR);
if (!proxyOk) {
  process.exit(1);
}

// Start or reuse container
if (await containerRunning(REPO_DIR, workspace)) {
  if (await mountsMatch(extraDirs)) {
    log('Reusing running container');
  } else {
    log('Extra directories changed \u2014 recreating container...');
    await teardown(REPO_DIR);
    await startContainer(workspace, REPO_DIR);
  }
} else {
  if (await anyContainerRunning(REPO_DIR)) {
    log('Workspace changed \u2014 tearing down previous container...');
    await teardown(REPO_DIR);
  }
  await startContainer(workspace, REPO_DIR);
}

// Copy global CLAUDE.md into container
await copyClaudeMd();

// Set terminal title so the user knows they're in moat
if (process.stdout.isTTY) {
  process.stdout.write('\x1b]2;moat\x07');
}

// Execute Claude Code (blocks until exit)
const exitCode = await execClaude(workspace, REPO_DIR, claudeArgs, extraDirs);

// Restore terminal title on exit
if (process.stdout.isTTY) {
  process.stdout.write('\x1b]2;\x07');
}
process.exit(exitCode);
