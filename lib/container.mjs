// Container lifecycle — check running, reuse, teardown, start, exec

import { basename } from 'node:path';
import { runCapture, runInherit } from './exec.mjs';
import { log } from './colors.mjs';

/**
 * Return compose command args prefix (project name + file flags).
 */
export function composeArgs(repoDir) {
  return [
    '--project-name', 'moat',
    '-f', `${repoDir}/docker-compose.yml`,
    '-f', `${repoDir}/docker-compose.services.yml`,
    '-f', `${repoDir}/docker-compose.extra-dirs.yml`,
  ];
}

/**
 * Check if the devcontainer is running for the given workspace.
 */
export async function containerRunning(repoDir, workspace) {
  try {
    const ps = await runCapture('docker', ['compose', ...composeArgs(repoDir), 'ps', '--status', 'running'], { allowFailure: true });
    if (!ps.stdout.includes('devcontainer')) return false;

    const inspect = await runCapture('docker', [
      'inspect', 'moat-devcontainer-1',
      '--format', '{{index .Config.Labels "devcontainer.local_folder"}}'
    ], { allowFailure: true });
    return inspect.stdout.trim() === workspace;
  } catch {
    return false;
  }
}

/**
 * Check if current /extra/* bind mounts match the expected extra dirs.
 */
export async function mountsMatch(extraDirs) {
  try {
    const inspect = await runCapture('docker', [
      'inspect', 'moat-devcontainer-1',
      '--format', '{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}}\n{{end}}{{end}}'
    ], { allowFailure: true });

    const currentMounts = inspect.stdout
      .split('\n')
      .filter(l => l.startsWith('/extra/'))
      .sort();

    const expectedMounts = extraDirs
      .map(dir => `/extra/${basename(dir)}`)
      .sort();

    return currentMounts.join('\n') === expectedMounts.join('\n');
  } catch {
    return false;
  }
}

/**
 * Check if any devcontainer is running (regardless of workspace).
 */
export async function anyContainerRunning(repoDir) {
  try {
    const ps = await runCapture('docker', ['compose', ...composeArgs(repoDir), 'ps', '--status', 'running'], { allowFailure: true });
    return ps.stdout.includes('devcontainer');
  } catch {
    return false;
  }
}

/**
 * Tear down containers.
 */
export async function teardown(repoDir) {
  await runCapture('docker', ['compose', ...composeArgs(repoDir), 'down'], { allowFailure: true });
}

/**
 * Start devcontainer via devcontainer CLI.
 */
export async function startContainer(workspace, repoDir) {
  log('Starting devcontainer...');
  const exitCode = await runInherit('devcontainer', [
    'up',
    '--workspace-folder', workspace,
    '--config', `${repoDir}/devcontainer.json`,
  ], {
    env: { MOAT_WORKSPACE: workspace },
  });
  if (exitCode !== 0) {
    throw new Error(`devcontainer up failed with exit code ${exitCode}`);
  }
}

/**
 * Execute Claude Code inside the container. Blocks until exit.
 * SIGINT is ignored by the Node process and passed through to the child.
 */
export async function execClaude(workspace, repoDir, claudeArgs, extraDirs) {
  // Build --add-dir flags for extra directories
  const addDirFlags = [];
  for (const dir of extraDirs) {
    addDirFlags.push('--add-dir', `/extra/${basename(dir)}`);
  }

  log('Launching Claude Code...');

  // Ignore SIGINT so the child (claude) handles it
  const origSigint = process.listeners('SIGINT');
  process.removeAllListeners('SIGINT');
  const ignore = () => {};
  process.on('SIGINT', ignore);

  try {
    const exitCode = await runInherit('devcontainer', [
      'exec',
      '--workspace-folder', workspace,
      '--config', `${repoDir}/devcontainer.json`,
      'claude', '--dangerously-skip-permissions',
      ...addDirFlags,
      ...claudeArgs,
    ]);
    return exitCode;
  } finally {
    // Restore SIGINT handlers
    process.removeListener('SIGINT', ignore);
    for (const fn of origSigint) {
      process.on('SIGINT', fn);
    }
  }
}

/**
 * Get the workspace label from a running container.
 */
export async function getContainerWorkspace() {
  try {
    const result = await runCapture('docker', [
      'inspect', 'moat-devcontainer-1',
      '--format', '{{index .Config.Labels "devcontainer.local_folder"}}'
    ], { allowFailure: true });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get existing /extra/* bind mount sources from running container.
 */
export async function getExtraMountSources() {
  try {
    const result = await runCapture('docker', [
      'inspect', 'moat-devcontainer-1',
      '--format', '{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}} {{.Source}}\n{{end}}{{end}}'
    ], { allowFailure: true });
    return result.stdout
      .split('\n')
      .filter(l => l.startsWith('/extra/'))
      .map(l => l.split(' ')[1])
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a specific container is running.
 */
export async function isContainerRunning(name = 'moat-devcontainer-1') {
  try {
    const result = await runCapture('docker', [
      'inspect', name, '--format', '{{.State.Running}}'
    ], { allowFailure: true });
    return result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}
