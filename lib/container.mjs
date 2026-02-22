// Container lifecycle — check running, reuse, teardown, start, exec

import { basename } from 'node:path';
import { runCapture, runInherit } from './exec.mjs';
import { log } from './colors.mjs';
import { workspaceId } from './workspace-id.mjs';

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
 * Stop and remove all agent containers for a workspace hash.
 */
export async function stopAgentContainers(wsHash) {
  try {
    const result = await runCapture('docker', [
      'ps', '-a', '--filter', `label=moat.workspace_hash=${wsHash}`,
      '--format', '{{.Names}}'
    ], { allowFailure: true });
    const containers = result.stdout.trim().split('\n').filter(Boolean);
    if (containers.length > 0) {
      await runCapture('docker', ['rm', '-f', ...containers], { allowFailure: true });
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Tear down containers for a workspace. Finds the compose project from container labels.
 * Also cleans up any agent containers for this workspace.
 */
export async function teardown(workspace) {
  // Stop agent containers first
  const wsHash = workspaceId(workspace);
  await stopAgentContainers(wsHash);

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
 * @param {string} projectName — compose project name (e.g. "moat-<hash>") to isolate concurrent sessions.
 */
export async function startContainer(workspace, repoDir, wsDataDir, projectName) {
  log('Starting devcontainer...');
  const args = [
    'up',
    '--workspace-folder', workspace,
    '--config', `${wsDataDir}/devcontainer.json`,
  ];
  const env = { MOAT_WORKSPACE: workspace };
  if (projectName) {
    env.COMPOSE_PROJECT_NAME = projectName;
  }
  const exitCode = await runInherit('devcontainer', args, { env });
  if (exitCode !== 0) {
    throw new Error(`devcontainer up failed with exit code ${exitCode}`);
  }
}

/**
 * Execute Claude Code inside the container. Blocks until exit.
 * SIGINT is ignored by the Node process and passed through to the child.
 * @param {string} projectName — compose project name to target the correct session.
 */
export async function execClaude(workspace, repoDir, wsDataDir, claudeArgs, extraDirs, projectName) {
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

  const args = [
    'exec',
    '--workspace-folder', workspace,
    '--config', `${wsDataDir}/devcontainer.json`,
    'claude', '--dangerously-skip-permissions', ...addDirFlags, ...claudeArgs,
  ];
  const env = {};
  if (projectName) {
    env.COMPOSE_PROJECT_NAME = projectName;
  }

  try {
    const exitCode = await runInherit('devcontainer', args, { env });
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
 * Find all running moat devcontainers (compose project name starts with "moat-").
 * Returns array of { name, workspace } objects.
 */
export async function findMoatContainers() {
  try {
    const result = await runCapture('docker', [
      'ps', '--filter', 'label=devcontainer.local_folder',
      '--format', '{{.Names}}\t{{.Label "devcontainer.local_folder"}}'
    ], { allowFailure: true });
    return result.stdout.trim().split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, workspace] = line.split('\t');
        return { name, workspace };
      })
      .filter(c => c.name.startsWith('moat-'));
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
