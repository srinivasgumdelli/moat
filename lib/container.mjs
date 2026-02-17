// Container lifecycle — check running, reuse, teardown, start, exec

import { basename } from 'node:path';
import { runCapture, runInherit } from './exec.mjs';
import { log } from './colors.mjs';

/**
 * Find a running devcontainer for the given workspace by Docker label.
 * Returns the container name or null.
 */
export async function findContainer(workspace) {
  try {
    const result = await runCapture('docker', [
      'ps', '--filter', `label=devcontainer.local_folder=${workspace}`,
      '--format', '{{.Names}}'
    ], { allowFailure: true });
    return result.stdout.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

/**
 * Get the Docker Compose project name from a running container's labels.
 */
async function getComposeProject(containerName) {
  try {
    const result = await runCapture('docker', [
      'inspect', containerName,
      '--format', '{{index .Config.Labels "com.docker.compose.project"}}'
    ], { allowFailure: true });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if current /extra/* bind mounts match the expected extra dirs.
 */
export async function mountsMatch(extraDirs, containerName) {
  try {
    const inspect = await runCapture('docker', [
      'inspect', containerName,
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
 * Tear down containers for a workspace. Finds the compose project from container labels.
 */
export async function teardown(workspace) {
  const container = await findContainer(workspace);
  if (!container) return;
  const project = await getComposeProject(container);
  if (project) {
    await runCapture('docker', ['compose', '--project-name', project, 'down'], { allowFailure: true });
  } else {
    await runCapture('docker', ['rm', '-f', container], { allowFailure: true });
  }
}

/**
 * Start devcontainer via devcontainer CLI.
 */
export async function startContainer(workspace, repoDir, wsDataDir) {
  log('Starting devcontainer...');
  const exitCode = await runInherit('devcontainer', [
    'up',
    '--workspace-folder', workspace,
    '--config', `${wsDataDir}/devcontainer.json`,
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
export async function execClaude(workspace, repoDir, wsDataDir, claudeArgs, extraDirs) {
  // Build --add-dir flags for extra directories
  const addDirFlags = [];
  for (const dir of extraDirs) {
    addDirFlags.push('--add-dir', `/extra/${basename(dir)}`);
  }

  log('Launching Claude Code (sandboxed)...');

  // Ignore SIGINT so the child (claude) handles it
  const origSigint = process.listeners('SIGINT');
  process.removeAllListeners('SIGINT');
  const ignore = () => {};
  process.on('SIGINT', ignore);

  try {
    const exitCode = await runInherit('devcontainer', [
      'exec',
      '--workspace-folder', workspace,
      '--config', `${wsDataDir}/devcontainer.json`,
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
export async function getContainerWorkspace(containerName) {
  try {
    const result = await runCapture('docker', [
      'inspect', containerName,
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
export async function getExtraMountSources(containerName) {
  try {
    const result = await runCapture('docker', [
      'inspect', containerName,
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
export async function isContainerRunning(name) {
  try {
    const result = await runCapture('docker', [
      'inspect', name, '--format', '{{.State.Running}}'
    ], { allowFailure: true });
    return result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}
