// Copy installed Claude Code plugins from host ~/.claude/plugins/ into the
// container. Plugins bundle commands, skills, hooks, agents, and MCPs — without
// this the sandbox can't see anything the user installed via /plugin.
//
// Path rewrites are required because metadata files embed absolute host paths:
//   - installed_plugins.json: installPath + projectPath
//   - known_marketplaces.json: installLocation
// Container paths are derived from CLAUDE_CONFIG_DIR (/home/node/.claude) and
// the workspace mount (/workspace).

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, err, DIM, RESET } from './colors.mjs';

const HOST_CLAUDE_DIR = join(process.env.HOME, '.claude');
const HOST_PLUGINS_DIR = join(HOST_CLAUDE_DIR, 'plugins');
const CONTAINER_CLAUDE_DIR = '/home/node/.claude';
const CONTAINER_PLUGINS_DIR = `${CONTAINER_CLAUDE_DIR}/plugins`;

function rewriteClaudeHomePath(p) {
  if (typeof p !== 'string') return p;
  if (p === HOST_CLAUDE_DIR) return CONTAINER_CLAUDE_DIR;
  if (p.startsWith(HOST_CLAUDE_DIR + '/')) {
    return CONTAINER_CLAUDE_DIR + p.slice(HOST_CLAUDE_DIR.length);
  }
  return p;
}

function rewriteProjectPath(p, workspace) {
  if (typeof p !== 'string' || !workspace) return p;
  if (p === workspace) return '/workspace';
  if (workspace.startsWith(p + '/')) return '/workspace';
  if (p.startsWith(workspace + '/')) return '/workspace' + p.slice(workspace.length);
  return p;
}

async function writeJsonToContainer(containerName, obj, destPath) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'moat-plugins-'));
  const tmpFile = join(tmpDir, 'payload.json');
  try {
    writeFileSync(tmpFile, JSON.stringify(obj, null, 2) + '\n');
    await runCapture('docker', ['cp', tmpFile, `${containerName}:${destPath}`]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Copy plugins from host ~/.claude/plugins/ into the container.
 * @param {string} containerName — Docker container name
 * @param {string} workspace — absolute path to host workspace (mounted at /workspace)
 */
export async function copyPlugins(containerName, workspace) {
  if (!existsSync(HOST_PLUGINS_DIR)) {
    return;
  }

  try {
    // Fresh dir each session so uninstalled plugins don't linger in the volume.
    await runCapture('docker', [
      'exec', '-u', 'root', containerName,
      'rm', '-rf', CONTAINER_PLUGINS_DIR,
    ]);
    await runCapture('docker', [
      'exec', '-u', 'root', containerName,
      'mkdir', '-p', CONTAINER_PLUGINS_DIR,
    ]);

    await runCapture('docker', [
      'cp', `${HOST_PLUGINS_DIR}/.`, `${containerName}:${CONTAINER_PLUGINS_DIR}/`,
    ]);

    let pluginCount = 0;
    const installedPath = join(HOST_PLUGINS_DIR, 'installed_plugins.json');
    if (existsSync(installedPath)) {
      try {
        const data = JSON.parse(readFileSync(installedPath, 'utf8'));
        if (data?.plugins && typeof data.plugins === 'object') {
          for (const entries of Object.values(data.plugins)) {
            if (!Array.isArray(entries)) continue;
            for (const entry of entries) {
              pluginCount++;
              if (entry.installPath) {
                entry.installPath = rewriteClaudeHomePath(entry.installPath);
              }
              if (entry.projectPath) {
                entry.projectPath = rewriteProjectPath(entry.projectPath, workspace);
              }
            }
          }
        }
        await writeJsonToContainer(
          containerName, data,
          `${CONTAINER_PLUGINS_DIR}/installed_plugins.json`,
        );
      } catch (e) {
        err(`Failed to rewrite installed_plugins.json: ${e.message}`);
      }
    }

    const marketPath = join(HOST_PLUGINS_DIR, 'known_marketplaces.json');
    if (existsSync(marketPath)) {
      try {
        const data = JSON.parse(readFileSync(marketPath, 'utf8'));
        if (data && typeof data === 'object') {
          for (const v of Object.values(data)) {
            if (v?.installLocation) {
              v.installLocation = rewriteClaudeHomePath(v.installLocation);
            }
          }
        }
        await writeJsonToContainer(
          containerName, data,
          `${CONTAINER_PLUGINS_DIR}/known_marketplaces.json`,
        );
      } catch (e) {
        err(`Failed to rewrite known_marketplaces.json: ${e.message}`);
      }
    }

    await runCapture('docker', [
      'exec', '-u', 'root', containerName,
      'chown', '-R', 'node:node', CONTAINER_PLUGINS_DIR,
    ]);

    const plural = pluginCount === 1 ? '' : 's';
    log(`Copied ${pluginCount} plugin${plural} from host ${DIM}(~/.claude/plugins)${RESET}`);
  } catch (e) {
    err(`Failed to copy plugins: ${e.result?.stderr?.trim() || e.message}`);
  }
}
