#!/usr/bin/env node
// Moat — sandboxed Claude Code launcher
// Usage: moat [workspace_path] [--add-dir <path>...] [claude args...]
// Subcommands: doctor | update [--version X.Y.Z] | down [--all] | stop | attach <dir> | detach <dir|--all> | plan | init | uninstall | allow-domain <domain...>

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

import { parseArgs } from './lib/cli.mjs';
import { log, err, DIM, RESET } from './lib/colors.mjs';
import { generateProjectConfig, generateExtraDirsYaml } from './lib/compose.mjs';
import { findContainer, mountsMatch, teardown, startContainer, execClaude, isContainerRunning } from './lib/container.mjs';
import { startProxy, stopProxy } from './lib/proxy.mjs';
import { doctor } from './lib/doctor.mjs';
import { update } from './lib/update.mjs';
import { down } from './lib/down.mjs';
import { attach, detach } from './lib/attach.mjs';
import { copyClaudeMd } from './lib/claude-md.mjs';
import { readHostMcpServers, extractMcpDomains, extractHttpMcpServers, copyMcpServers } from './lib/mcp-servers.mjs';
import { workspaceId, workspaceDataDir } from './lib/workspace-id.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = __dirname;
const DATA_DIR = join(process.env.HOME, '.moat', 'data');

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
  const allFlag = subcommandArgs.includes('--all');
  await down(REPO_DIR, { all: allFlag, workspace });
  process.exit(0);
}

if (subcommand === 'stop') {
  log('Stopping tool proxy...');
  await stopProxy();
  log('Done. Proxy will restart on next moat launch.');
  process.exit(0);
}

if (subcommand === 'attach') {
  await attach(REPO_DIR, subcommandArgs, workspace);
  process.exit(0);
}

if (subcommand === 'detach') {
  await detach(subcommandArgs);
  process.exit(0);
}

if (subcommand === 'allow-domain') {
  const { allowDomain } = await import('./lib/allow-domain.mjs');
  await allowDomain(subcommandArgs, workspace);
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

// Compute per-workspace data directory
const hash = workspaceId(workspace);
const wsDir = workspaceDataDir(hash);
mkdirSync(wsDir, { recursive: true });

// Legacy migration: tear down old single-instance container
if (await isContainerRunning('moat-devcontainer-1')) {
  log('Removing legacy moat container...');
  try {
    execSync('docker rm -f moat-devcontainer-1 moat-squid-1 2>/dev/null', { stdio: 'pipe' });
  } catch {}
}

// Generate docker-compose override for extra directories into wsDir
writeFileSync(join(wsDir, 'docker-compose.extra-dirs.yml'), generateExtraDirsYaml(extraDirs));

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

// Read host MCP servers early — domains go into squid before container starts
const hostMcpServers = readHostMcpServers();
const mcpDomains = extractMcpDomains(hostMcpServers);

// Extract external HTTP MCP servers to proxy through tool-proxy (auth stays on host)
const httpMcpServers = extractHttpMcpServers(hostMcpServers);
// Always write mcp-servers.json (even empty) to clear stale configs from previous runs
writeFileSync(join(DATA_DIR, 'mcp-servers.json'), JSON.stringify(httpMcpServers, null, 2) + '\n');
if (Object.keys(httpMcpServers).length > 0) {
  log(`Proxying ${Object.keys(httpMcpServers).length} HTTP MCP server${Object.keys(httpMcpServers).length === 1 ? '' : 's'} through tool-proxy ${DIM}(${Object.keys(httpMcpServers).join(', ')})${RESET}`);
}

// Generate per-project config from .moat.yml (writes to wsDir)
const meta = generateProjectConfig(workspace, REPO_DIR, wsDir, mcpDomains);
if (meta.has_services) {
  log(`Project services: ${DIM}${meta.service_names.join(', ')}${RESET}`);
}
if (meta.extra_domains.length > 0) {
  log(`Extra domains: ${DIM}${meta.extra_domains.join(', ')}${RESET}`);
}
if (mcpDomains.length > 0) {
  log(`MCP domains: ${DIM}${mcpDomains.join(', ')}${RESET}`);
}
if (meta.has_docker) {
  log('Docker access enabled via Podman (rootless)');
}

// Generate per-workspace devcontainer.json
const composeFiles = [
  `${REPO_DIR}/docker-compose.yml`,
  `${wsDir}/docker-compose.services.yml`,
  `${wsDir}/docker-compose.extra-dirs.yml`,
];
if (meta.has_docker) {
  composeFiles.push(`${wsDir}/docker-compose.docker.yml`);
}
const devcontainerConfig = {
  name: `moat-${hash}`,
  dockerComposeFile: composeFiles,
  service: 'devcontainer',
  workspaceFolder: '/workspace',
  customizations: {
    vscode: {
      extensions: [
        'anthropic.claude-code',
        'dbaeumer.vscode-eslint',
        'esbenp.prettier-vscode',
        'eamodio.gitlens',
      ],
      settings: {
        'editor.formatOnSave': true,
        'editor.defaultFormatter': 'esbenp.prettier-vscode',
        'terminal.integrated.defaultProfile.linux': 'zsh',
      },
    },
  },
  containerEnv: {
    MOAT_WORKSPACE_HASH: hash,
  },
  remoteUser: 'node',
  remoteEnv: {
    ANTHROPIC_API_KEY: '${localEnv:ANTHROPIC_API_KEY}',
  },
  postStartCommand: "echo '[moat] Container ready'",
};
writeFileSync(join(wsDir, 'devcontainer.json'), JSON.stringify(devcontainerConfig, null, 2) + '\n');

// Write path mappings for tool proxy (per-workspace, so multiple sessions don't clobber each other)
const pathMappings = { '/workspace': workspace };
for (const dir of extraDirs) {
  pathMappings[`/extra/${basename(dir)}`] = dir;
}
writeFileSync(join(wsDir, 'path-mappings.json'), JSON.stringify(pathMappings) + '\n');

// On exit: clean up per-workspace path mappings so the proxy doesn't serve stale data
process.on('exit', () => {
  try { unlinkSync(join(wsDir, 'path-mappings.json')); } catch {}
});
process.on('SIGTERM', () => process.exit(0));

// Start or reuse tool proxy
ensureTokenInRepo();
const proxyOk = await startProxy(REPO_DIR, DATA_DIR);
if (!proxyOk) {
  process.exit(1);
}

// Per-workspace compose project name — isolates concurrent sessions
const projectName = `moat-${hash}`;

// Start or reuse container
const existing = await findContainer(workspace);
if (existing) {
  if (await mountsMatch(extraDirs, existing)) {
    log('Reusing running container');
  } else {
    log('Extra directories changed — recreating container...');
    await teardown(workspace);
    await startContainer(workspace, REPO_DIR, wsDir, projectName);
  }
} else {
  await startContainer(workspace, REPO_DIR, wsDir, projectName);
}

// Find actual container name (devcontainer CLI chooses the name, not us)
const containerName = await findContainer(workspace);
if (!containerName) {
  err('Container not found after startup');
  process.exit(1);
}

// Copy global CLAUDE.md into container
await copyClaudeMd(containerName);

// Forward host MCP server configs into container
// External HTTP servers get proxied through tool-proxy (auth stays on host)
const proxyToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf-8').trim() : null;
const proxiedServerNames = new Set(Object.keys(httpMcpServers));
await copyMcpServers(containerName, hostMcpServers, { proxyToken, proxiedServers: proxiedServerNames });

// Execute Claude Code (blocks until exit)
const exitCode = await execClaude(workspace, REPO_DIR, wsDir, claudeArgs, extraDirs, projectName);
process.exit(exitCode);
