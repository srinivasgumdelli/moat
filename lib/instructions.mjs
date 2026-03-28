// Generalized instruction file copier — delegates to runtime-specific logic
// For Claude: uses existing copyClaudeMd behavior
// For other runtimes: copies moat-claude.md to the runtime's instruction path

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { copyClaudeMd } from './claude-md.mjs';
import { copySkills, copyCommands } from './skills.mjs';
import { copyMemory } from './memory.mjs';
import { copySettings } from './settings.mjs';
import { runCapture } from './exec.mjs';
import { log, DIM, RESET } from './colors.mjs';

/**
 * Copy instruction files into the container for the given runtime.
 * @param {string} containerName — Docker container name
 * @param {string} repoDir — path to moat repo on host
 * @param {object} runtime — runtime config object
 * @param {string} workspace — absolute path to workspace on host
 */
export async function copyInstructions(containerName, repoDir, runtime, workspace) {
  if (runtime.configDir === '.claude') {
    // Claude Code — use the full merge logic (base + host CLAUDE.md)
    await copyClaudeMd(containerName, repoDir);
    // Copy skills and commands from host into container
    await copySkills(containerName);
    await copyCommands(containerName);
    // Copy project memory from host into container
    await copyMemory(containerName, workspace);
    // Merge host global settings into container settings
    await copySettings(containerName);
    return;
  }

  // Other runtimes — copy moat-claude.md as a general instruction file
  // This provides the planning-first workflow rules even for non-Claude runtimes
  const baseSrc = join(repoDir, 'moat-claude.md');
  if (!existsSync(baseSrc)) return;

  if (runtime.instructionsFile) {
    try {
      const targetPath = `/workspace/${runtime.instructionsFile}`;
      await runCapture('docker', [
        'cp', baseSrc, `${containerName}:${targetPath}`,
      ]);
      await runCapture('docker', [
        'exec', containerName,
        'chown', 'node:node', targetPath,
      ]);
      log(`Copied instruction file ${DIM}(${runtime.instructionsFile})${RESET}`);
    } catch {
      // Non-fatal
    }
  }
}
