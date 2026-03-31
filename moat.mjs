#!/usr/bin/env node
// Moat — sandboxed Claude Code launcher
// Usage: moat [workspace_path] [--add-dir <path>...] [claude args...]
// Subcommands: help | doctor | update [--version X.Y.Z] | down [--all] | stop | attach-dir <dir> | detach-dir <dir|--all> | init | audit [hash] | rewind [--list|--to <sha>] | uninstall | allow-domain <domain...>

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

import { parseArgs } from './lib/cli.mjs';
import { log, err, DIM, RESET } from './lib/colors.mjs';
import { generateProjectConfig, generateExtraDirsYaml } from './lib/compose.mjs';
import { findContainer, mountsMatch, teardown, startContainer, execRuntime, isContainerRunning } from './lib/container.mjs';
import { startProxy, stopProxy } from './lib/proxy.mjs';
import { doctor } from './lib/doctor.mjs';
import { update } from './lib/update.mjs';
import { down } from './lib/down.mjs';
import { attach, detach } from './lib/attach.mjs';
import { copyInstructions } from './lib/instructions.mjs';
import { refreshHooks } from './lib/hooks.mjs';
import { readHostMcpServers, extractMcpDomains, extractHttpMcpServers, copyMcpServers, writeContainerSettings, copySettingsLocal } from './lib/mcp-servers.mjs';
import { workspaceId, workspaceDataDir } from './lib/workspace-id.mjs';
import { createAuditLogger } from './lib/audit.mjs';
import { getRuntime, resolveRuntimeName } from './lib/runtimes/index.mjs';
import { syncMemoryToHost } from './lib/memory.mjs';

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

let { subcommand, subcommandArgs, workspace, extraDirs, claudeArgs, runtimeArg } = parsed;
let dispatchOpts = null; // set when subcommand === 'dispatch'

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

if (subcommand === 'help') {
  const { BOLD, DIM, CYAN, RESET } = await import('./lib/colors.mjs');
  const { listRuntimes } = await import('./lib/runtimes/index.mjs');
  const runtimes = listRuntimes().join(', ');
  console.log(`
${BOLD}moat${RESET} — sandboxed coding agent launcher

${BOLD}USAGE${RESET}
  moat [workspace] [options] [-- claude args...]
  moat <command> [args]

${BOLD}OPTIONS${RESET}
  --runtime <name>    Runtime to use (${runtimes}) ${DIM}[default: claude]${RESET}
  --add-dir <path>    Mount additional directory into the container (repeatable)
  --help, -h          Show this help message

${BOLD}COMMANDS${RESET}
  ${CYAN}dispatch${RESET} [workspace] ["task"]  Run a task autonomously (interactive if no task given)
    --headless        Skip the Claude reasoning layer; send prompt directly to agent (task required)
    --model <name>    Model override (e.g. claude-haiku-4-5-20251001)
    --runtime <name>  Runtime to use ${DIM}[default: claude]${RESET}
  ${CYAN}init${RESET}                Auto-detect dependencies and generate .moat.yml
  ${CYAN}doctor${RESET}              Check system prerequisites and configuration
  ${CYAN}update${RESET}              Update moat to the latest version
    --version X.Y.Z   Pin to a specific version
  ${CYAN}ps${RESET}                  List running moat containers
  ${CYAN}down${RESET}                Stop and remove containers
    --all             Stop all moat containers
  ${CYAN}stop${RESET}                Stop the tool proxy
  ${CYAN}attach-dir${RESET} <dir>    Mount an additional directory to a running container
  ${CYAN}detach-dir${RESET} <dir|--all>  Unmount a previously attached directory
  ${CYAN}log${RESET} [lines]         Show tool proxy logs ${DIM}[default: 50 lines]${RESET}
    --follow, -f      Follow log output
  ${CYAN}audit${RESET} [hash]        View audit log for a workspace
    --tail            Follow audit events live
  ${CYAN}rewind${RESET}              Browse and restore workspace snapshots
    --list            List available snapshots
    --to <sha>        Restore to a specific snapshot
  ${CYAN}allow-domain${RESET} <domain...>  Whitelist domains for outbound network access
  ${CYAN}uninstall${RESET}           Remove moat and all its data

${BOLD}EXAMPLES${RESET}
  moat                                      ${DIM}# Launch in current directory${RESET}
  moat ~/projects/myapp                     ${DIM}# Launch with a specific workspace${RESET}
  moat dispatch ~/app "add a README"        ${DIM}# Dispatch task to Claude Code${RESET}
  moat dispatch ~/app "fix bug" --headless  ${DIM}# Headless agent, no reasoning layer${RESET}
  moat --runtime codex                      ${DIM}# Use Codex runtime${RESET}
  moat --add-dir ~/shared-libs              ${DIM}# Mount extra directory${RESET}
  moat doctor                               ${DIM}# Check prerequisites${RESET}
  moat down --all                           ${DIM}# Stop all containers${RESET}
`);
  process.exit(0);
}

if (subcommand === 'doctor') {
  await doctor(REPO_DIR, DATA_DIR);
  process.exit(0);
}

if (subcommand === 'ps') {
  const { ps } = await import('./lib/ps.mjs');
  await ps();
  process.exit(0);
}

if (subcommand === 'log') {
  const { PROXY_LOG } = await import('./lib/proxy.mjs');
  const followFlag = subcommandArgs.includes('--follow') || subcommandArgs.includes('-f');
  if (!existsSync(PROXY_LOG)) {
    err(`No log file at ${PROXY_LOG}`);
    process.exit(1);
  }
  if (followFlag) {
    spawnSync('tail', ['-f', PROXY_LOG], { stdio: 'inherit' });
  } else {
    const lines = subcommandArgs.find(a => /^\d+$/.test(a)) || '50';
    spawnSync('tail', ['-n', lines, PROXY_LOG], { stdio: 'inherit' });
  }
  process.exit(0);
}

if (subcommand === 'down') {
  const allFlag = subcommandArgs.includes('--all');
  // First non-flag arg is a pattern (e.g. moat down myapp, moat down moat-abc*)
  const pattern = subcommandArgs.find(a => a !== '--all' && !a.startsWith('-'));
  await down(REPO_DIR, { all: allFlag, workspace, pattern });
  process.exit(0);
}

if (subcommand === 'stop') {
  log('Stopping tool proxy...');
  await stopProxy();
  log('Done. Proxy will restart on next moat launch.');
  process.exit(0);
}

if (subcommand === 'attach-dir') {
  await attach(REPO_DIR, subcommandArgs, workspace);
  process.exit(0);
}

if (subcommand === 'detach-dir') {
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

if (subcommand === 'audit') {
  const { auditView } = await import('./lib/audit-view.mjs');
  await auditView(subcommandArgs);
  process.exit(0);
}

if (subcommand === 'rewind') {
  const { rewind } = await import('./lib/rewind.mjs');
  await rewind(subcommandArgs);
  process.exit(0);
}

if (subcommand === 'init') {
  const { initConfig } = await import('./lib/init-config.mjs');
  await initConfig(workspace);
  process.exit(0);
}

if (subcommand === 'dispatch') {
  // Parse: dispatch [workspace] ["task"] [--headless] [--model <name>] [--runtime <name>]
  const dispatchRawArgs = subcommandArgs;
  let dispatchWorkspace = process.cwd();
  let dispatchTask = null;
  let dispatchHeadless = false;
  let dispatchModel = null;
  let dispatchRuntime = null;
  const { statSync: _statSync } = await import('node:fs');
  const { resolve: _resolve } = await import('node:path');

  for (let i = 0; i < dispatchRawArgs.length; i++) {
    const a = dispatchRawArgs[i];
    if (a === '--headless') {
      dispatchHeadless = true;
    } else if (a === '--model') {
      i++;
      dispatchModel = dispatchRawArgs[i];
    } else if (a === '--runtime') {
      i++;
      dispatchRuntime = dispatchRawArgs[i];
    } else if (!a.startsWith('-')) {
      try {
        if (existsSync(a) && _statSync(a).isDirectory()) {
          dispatchWorkspace = _resolve(a);
        } else if (dispatchTask === null) {
          dispatchTask = a;
        }
      } catch {
        if (dispatchTask === null) dispatchTask = a;
      }
    }
  }

  if (!dispatchTask && dispatchHeadless) {
    err('dispatch --headless requires a task prompt\nUsage: moat dispatch [workspace] "task" --headless [--model <name>]');
    process.exit(1);
  }

  // Override main flow variables so container setup uses dispatch context
  workspace = dispatchWorkspace;
  if (dispatchRuntime) runtimeArg = dispatchRuntime;
  subcommand = null; // fall through to main flow

  if (dispatchHeadless) {
    // Mode 3: headless agent — main flow sets up container, then we spawn directly
    dispatchOpts = { headless: true, task: dispatchTask, model: dispatchModel };
  } else if (dispatchTask) {
    // Mode 2: Claude Code as intelligence layer, runs non-interactively with -p
    claudeArgs = ['-p', dispatchTask, ...(dispatchModel ? ['--model', dispatchModel] : [])];
    dispatchOpts = { headless: false };
  } else {
    // Mode 1: interactive — no task given, launch Claude interactively in the workspace
    dispatchOpts = { headless: false };
  }
}

// --- Main flow ---

// Compute moat version from git (short SHA + dirty flag)
let moatVersion = 'unknown';
try {
  const sha = execSync('git -C ' + JSON.stringify(REPO_DIR) + ' rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  const dirty = execSync('git -C ' + JSON.stringify(REPO_DIR) + ' status --porcelain', { encoding: 'utf-8' }).trim();
  moatVersion = sha + (dirty ? '-dirty' : '');
} catch {}

// Resolve runtime
const runtimeName = resolveRuntimeName(runtimeArg, workspace);
let runtime;
try {
  runtime = getRuntime(runtimeName);
} catch (e) {
  err(e.message);
  process.exit(1);
}

process.env.MOAT_WORKSPACE = workspace;

// Compute per-workspace data directory
const hash = workspaceId(workspace);
const wsDir = workspaceDataDir(hash);
mkdirSync(wsDir, { recursive: true });
const configVolume = `moat-config-${hash}`;

// Create audit logger for this session
const audit = createAuditLogger(wsDir);
const sessionStartTime = Date.now();
let headSha = null;
try {
  headSha = execSync('git rev-parse HEAD', { cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {}
audit.emit('session.start', { workspace, hash, moat_version: moatVersion, runtime: runtimeName, head_sha: headSha });

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
const hostMcpServers = readHostMcpServers(runtime);
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

// Generate per-workspace volume override (config volume scoped per workspace)
const volumesOverride = [
  'volumes:',
  '  moat-config:',
  `    name: ${configVolume}`,
  '    external: true',
].join('\n') + '\n';
writeFileSync(join(wsDir, 'docker-compose.volumes.yml'), volumesOverride);

// Generate per-workspace devcontainer.json
const composeFiles = [
  `${REPO_DIR}/docker-compose.yml`,
  `${wsDir}/docker-compose.volumes.yml`,
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
        ...(runtime.vscodeExtension ? [runtime.vscodeExtension] : []),
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
    MOAT_VERSION: moatVersion,
  },
  remoteUser: 'node',
  remoteEnv: { ...runtime.envVars },
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

// Build agent image if missing (cache by runtime+version to avoid redundant builds)
ensureTokenInRepo();
const runtimeVersion = process.env[runtime.versionEnvVar] || runtime.defaultVersion;
const agentImageTag = `moat-agent-${runtimeName}:${runtimeVersion}`;
const agentImageLatest = `moat-agent-${runtimeName}:latest`;
try {
  execSync(`docker image inspect ${agentImageTag}`, { stdio: 'pipe' });
  log(`Agent image cached (${agentImageTag})`);
} catch {
  log(`Building agent image (${runtime.displayName} ${runtimeVersion})...`);
  const buildResult = spawnSync('docker', [
    'build',
    '-t', agentImageTag,
    '-t', agentImageLatest,
    '--build-arg', `RUNTIME=${runtimeName}`,
    '--build-arg', `RUNTIME_VERSION=${runtimeVersion}`,
    // Keep backward compat with existing Dockerfile.agent
    '--build-arg', `CLAUDE_CODE_VERSION=${runtimeVersion}`,
    '-f', join(REPO_DIR, 'Dockerfile.agent'),
    REPO_DIR
  ], { stdio: 'inherit' });
  if (buildResult.status !== 0) {
    err('Failed to build agent image');
    process.exit(1);
  }
}

// Store agent image tag in wsDir for tool-proxy to use
writeFileSync(join(wsDir, 'agent-image-tag.txt'), agentImageTag + '\n');

// Start or reuse tool proxy
const proxyOk = await startProxy(REPO_DIR, DATA_DIR, { workspace });
if (!proxyOk) {
  process.exit(1);
}

// Pre-create shared volumes (external: true requires they exist before compose up)
// Config volume is per-workspace so --continue/--resume scopes to the correct session
for (const vol of ['moat-bashhistory', configVolume]) {
  try { execSync(`docker volume inspect ${vol}`, { stdio: 'pipe' }); }
  catch { execSync(`docker volume create ${vol}`, { stdio: 'pipe' }); }
}

// Per-workspace compose project name — isolates concurrent sessions
const projectName = `moat-${hash}`;

// Start or reuse container
const existing = await findContainer(workspace);
if (existing) {
  if (await mountsMatch(extraDirs, existing, configVolume)) {
    log('Reusing running container');
  } else {
    log('Container config changed — recreating container...');
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

// Copy instruction files into container
await copyInstructions(containerName, REPO_DIR, runtime, workspace);

// Refresh hook scripts from repo (volume persistence shadows Dockerfile COPY)
if (runtime.configDir === '.claude') {
  await refreshHooks(containerName, REPO_DIR);
}

// Write quality gate config into container
{
  const moatYmlPath = join(workspace, '.moat.yml');
  let gateConfig = { diagnostics: true, tests: true, build: false, build_command: null };
  if (existsSync(moatYmlPath)) {
    try {
      const { parseYaml } = await import('./lib/yaml.mjs');
      const config = parseYaml(readFileSync(moatYmlPath, 'utf-8'));
      if (config.quality_gates?.pre_push) {
        const pp = config.quality_gates.pre_push;
        if (pp.diagnostics !== undefined) gateConfig.diagnostics = pp.diagnostics;
        if (pp.tests !== undefined) gateConfig.tests = pp.tests;
        if (pp.build !== undefined) gateConfig.build = pp.build;
        if (pp.build_command !== undefined) gateConfig.build_command = pp.build_command;
      }
    } catch {}
  }
  const tmpConfig = join(wsDir, 'quality-gate-config.json');
  writeFileSync(tmpConfig, JSON.stringify(gateConfig, null, 2) + '\n');
  try {
    execSync(`docker cp ${JSON.stringify(tmpConfig)} ${containerName}:/home/node/.claude/quality-gate-config.json`, { stdio: 'pipe' });
  } catch {}
}

// Forward host MCP server configs into container (Claude Code only — other runtimes don't use MCP)
if (runtime.configDir === '.claude') {
  const proxyToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf-8').trim() : null;
  const proxiedServerNames = new Set(Object.keys(httpMcpServers));
  await copyMcpServers(containerName, hostMcpServers, { proxyToken, proxiedServers: proxiedServerNames });
  // Copy host settings.local.json (carries nudge hooks and other local overrides)
  await copySettingsLocal(containerName);
  // Force permissions.defaultMode in settings.json so it takes effect even if the CLI flag is ignored
  await writeContainerSettings(containerName, { permissions: { defaultMode: 'bypassPermissions' } });
}

// Execute runtime or headless dispatch
let exitCode;
if (dispatchOpts?.headless) {
  const { runHeadlessDispatch } = await import('./lib/dispatch.mjs');
  const proxyToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf-8').trim() : null;
  const result = await runHeadlessDispatch(hash, workspace, proxyToken, dispatchOpts.task, {
    model: dispatchOpts.model,
  });
  exitCode = result?.exit_code ?? 0;
} else {
  exitCode = await execRuntime(runtime, workspace, REPO_DIR, wsDir, claudeArgs, extraDirs, projectName);
}

// Sync memories created in the container back to host for persistence
if (runtime.configDir === '.claude') {
  await syncMemoryToHost(containerName, workspace);
}

// Session-end auto-commit: save uncommitted work with [moat-checkpoint] prefix
{
  let autoCommitEnabled = true;
  const moatYmlPath = join(workspace, '.moat.yml');
  if (existsSync(moatYmlPath)) {
    try {
      const { parseYaml } = await import('./lib/yaml.mjs');
      const config = parseYaml(readFileSync(moatYmlPath, 'utf-8'));
      if (config.recovery?.auto_commit_on_end === false) autoCommitEnabled = false;
    } catch {}
  }
  if (autoCommitEnabled) {
    try {
      const status = execSync('git status --porcelain', { cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (status) {
        execSync('git add -A', { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
        execSync('git commit -m "[moat-checkpoint] session end auto-save" --no-verify', { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
        process.stderr.write('[moat] Auto-saved uncommitted changes at session end\n');
      }
    } catch {}
  }
}

// Record HEAD SHA at session end
let endHeadSha = null;
try {
  endHeadSha = execSync('git rev-parse HEAD', { cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch {}
audit.emit('session.end', { exit_code: exitCode, duration_ms: Date.now() - sessionStartTime, head_sha: endHeadSha });
process.exit(exitCode);
