// Copy Claude Code memories from host into container
// Host: ~/.claude/projects/<workspace-path-as-key>/memory/
// Container: /home/node/.claude/projects/-workspace/memory/

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, DIM, RESET } from './colors.mjs';

const CONTAINER_PROJECTS_DIR = '/home/node/.claude/projects';
const CONTAINER_WORKSPACE_KEY = '-workspace';
const CONTAINER_MEMORY_DIR = `${CONTAINER_PROJECTS_DIR}/${CONTAINER_WORKSPACE_KEY}/memory`;

/**
 * Derive the ~/.claude/projects/ key from an absolute workspace path.
 * Claude Code replaces each '/' with '-', including the leading slash.
 * e.g. /Users/alice/Repos/myapp -> -Users-alice-Repos-myapp
 */
function workspaceProjectKey(workspacePath) {
  return workspacePath.replace(/\//g, '-');
}

/**
 * Sync memory files from the container back to the host.
 * Called at session end to persist memories created during the session.
 * Container files win on conflict (they're newer); host-only files are untouched.
 * @param {string} containerName - Docker container name
 * @param {string} workspace - absolute path to workspace on the host
 */
export async function syncMemoryToHost(containerName, workspace) {
  const key = workspaceProjectKey(workspace);
  const hostMemoryDir = join(process.env.HOME, '.claude', 'projects', key, 'memory');

  try {
    // Check if memory dir exists and has files in the container
    const { stdout } = await runCapture('docker', [
      'exec', containerName,
      'sh', '-c', `[ -d ${CONTAINER_MEMORY_DIR} ] && ls -A ${CONTAINER_MEMORY_DIR} | wc -l | tr -d ' ' || echo 0`,
    ]);
    if (stdout.trim() === '0') return;

    // Ensure host memory dir exists
    const { mkdirSync } = await import('node:fs');
    mkdirSync(hostMemoryDir, { recursive: true });

    // Copy from container to host (container files win on conflict)
    await runCapture('docker', [
      'cp', `${containerName}:${CONTAINER_MEMORY_DIR}/.`, `${hostMemoryDir}/`,
    ]);
  } catch {
    // Non-fatal
  }
}

/**
 * Copy project memory files from the host into the container.
 * The container sees /workspace as its working directory, so memories
 * are planted at /home/node/.claude/projects/-workspace/memory/.
 * @param {string} containerName - Docker container name
 * @param {string} workspace - absolute path to workspace on the host
 */
export async function copyMemory(containerName, workspace) {
  const key = workspaceProjectKey(workspace);
  const hostMemoryDir = join(process.env.HOME, '.claude', 'projects', key, 'memory');

  if (!existsSync(hostMemoryDir)) {
    return; // No memories for this workspace
  }

  let files;
  try {
    files = readdirSync(hostMemoryDir, { withFileTypes: true });
  } catch {
    return;
  }

  if (files.length === 0) {
    return; // Memory dir exists but is empty
  }

  try {
    // Ensure target directory exists in container
    await runCapture('docker', [
      'exec', containerName,
      'mkdir', '-p', CONTAINER_MEMORY_DIR,
    ]);

    // Copy all memory files into container
    await runCapture('docker', [
      'cp', `${hostMemoryDir}/.`,
      `${containerName}:${CONTAINER_MEMORY_DIR}/`,
    ]);

    // Fix ownership
    await runCapture('docker', [
      'exec', containerName,
      'chown', '-R', 'node:node', `${CONTAINER_PROJECTS_DIR}/${CONTAINER_WORKSPACE_KEY}`,
    ]);

    const fileCount = files.length;
    const plural = fileCount === 1 ? '' : 's';
    log(`Loaded ${fileCount} memory file${plural} from host ${DIM}(~/.claude/projects/${key}/memory)${RESET}`);
  } catch {
    // Non-fatal — memories are optional
  }
}
