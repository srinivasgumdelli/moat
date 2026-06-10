// Container lifecycle — check running, reuse, teardown, start, exec

import { basename } from 'node:path';
import { runCapture, runInherit } from './exec.mjs';
import { log } from './colors.mjs';
import { workspaceDataDir } from './workspace-id.mjs';

/**
 * Find the running devcontainer for a specific session by compose project label.
 * Returns the container name or null.
 */
export async function findSessionContainer(projectName) {
  try {
    const result = await runCapture('docker', [
      'ps',
      '--filter', `label=com.docker.compose.project=${projectName}`,
      '--filter', 'label=com.docker.compose.service=devcontainer',
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
export async function getComposeProject(containerName) {
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
export async function mountsMatch(extraDirs, containerName, expectedConfigVolume) {
  try {
    const inspect = await runCapture('docker', [
      'inspect', containerName,
      '--format', '{{range .Mounts}}{{.Type}} {{.Destination}} {{.Name}}\n{{end}}'
    ], { allowFailure: true });

    const lines = inspect.stdout.split('\n').filter(Boolean);

    // Check extra directory bind mounts
    const currentMounts = lines
      .filter(l => l.startsWith('bind /extra/'))
      .map(l => l.split(' ')[1])
      .sort();

    const expectedMounts = extraDirs
      .map(dir => `/extra/${basename(dir)}`)
      .sort();

    if (currentMounts.join('\n') !== expectedMounts.join('\n')) return false;

    // Check config volume name matches expected per-workspace volume
    if (expectedConfigVolume) {
      const configMount = lines.find(l => l.includes('/home/node/.claude'));
      if (configMount) {
        const volumeName = configMount.split(' ')[2];
        if (volumeName !== expectedConfigVolume) return false;
      }
    }

    return true;
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
 * Tear down a single session's containers (devcontainer + squid + its agents).
 * Resolves the compose project from the container's labels.
 * The per-workspace config volume is left alone — it's shared across sessions
 * and keeps --continue/--resume history.
 */
export async function teardownSession(containerName) {
  const project = await getComposeProject(containerName);
  const sid = project && project.startsWith('moat-') ? project.slice('moat-'.length) : null;

  // Agent containers are labeled moat.workspace_hash=<sessionId>
  if (sid) await stopAgentContainers(sid);

  if (project) {
    await runCapture('docker', ['compose', '--project-name', project, 'down'], { allowFailure: true });
  } else {
    await runCapture('docker', ['rm', '-f', containerName], { allowFailure: true });
  }
}

/**
 * Derive a running container's per-session data directory from its compose project.
 * Returns null if the project label is missing or not moat-managed.
 */
export async function sessionDirFromContainer(containerName) {
  const project = await getComposeProject(containerName);
  if (!project || !project.startsWith('moat-')) return null;
  return workspaceDataDir(project.slice('moat-'.length));
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
 * Execute a coding assistant runtime inside the container. Blocks until exit.
 * SIGINT is ignored by the Node process and passed through to the child.
 * @param {object} runtime — runtime config object (from lib/runtimes/)
 * @param {string} workspace — host workspace path
 * @param {string} repoDir — host moat repo path
 * @param {string} wsDataDir — per-workspace data directory
 * @param {string[]} runtimeArgs — additional args to pass to the runtime
 * @param {string[]} extraDirs — extra directories to mount
 * @param {string} projectName — compose project name to target the correct session
 */
export async function execRuntime(runtime, workspace, repoDir, wsDataDir, runtimeArgs, extraDirs, projectName) {
  // Build --add-dir flags for extra directories (only if runtime supports it)
  const addDirFlags = [];
  if (runtime.flags.addDir) {
    for (const dir of extraDirs) {
      addDirFlags.push(runtime.flags.addDir, `/extra/${basename(dir)}`);
    }
  }

  log(`Launching ${runtime.displayName} (sandboxed)...`);

  // Ignore SIGINT so the child (runtime) handles it
  const origSigint = process.listeners('SIGINT');
  process.removeAllListeners('SIGINT');
  const ignore = () => {};
  process.on('SIGINT', ignore);

  // Build the runtime command
  const runtimeCmd = [runtime.binary];
  if (runtime.flags.skipPermissions) {
    runtimeCmd.push(runtime.flags.skipPermissions);
  }
  // Explicitly set permission mode to bypassPermissions (workaround for Claude Code bug)
  if (runtime.flags.permissionMode) {
    runtimeCmd.push(runtime.flags.permissionMode, 'bypassPermissions');
  }

  const args = [
    'exec',
    '--workspace-folder', workspace,
    '--config', `${wsDataDir}/devcontainer.json`,
    ...runtimeCmd, ...addDirFlags, ...runtimeArgs,
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

// Backward-compatible alias
export { execRuntime as execClaude };

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
 * Returns array of { name, workspace, project, session } objects.
 * session is the compose-project suffix after "moat-<hash8>-" ('' for legacy containers).
 */
export async function findMoatContainers() {
  try {
    const result = await runCapture('docker', [
      'ps', '--filter', 'label=devcontainer.local_folder',
      '--format', '{{.Names}}\t{{.Label "devcontainer.local_folder"}}\t{{.Label "com.docker.compose.project"}}'
    ], { allowFailure: true });
    return result.stdout.trim().split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, workspace, project] = line.split('\t');
        const m = (project || '').match(/^moat-[0-9a-f]{8}-(.+)$/);
        return { name, workspace, project: project || '', session: m ? m[1] : '' };
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
