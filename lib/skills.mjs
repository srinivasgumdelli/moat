// Copy skills from host ~/.claude/skills/ into container
// Skills are user-created commands that extend Claude Code functionality

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, DIM, RESET } from './colors.mjs';

const HOST_SKILLS_DIR = join(process.env.HOME, '.claude', 'skills');
const CONTAINER_SKILLS_DIR = '/home/node/.claude/skills';

/**
 * Copy skills from host ~/.claude/skills/ into the container.
 * Skills are copied recursively so that multi-file skills work correctly.
 * @param {string} containerName — Docker container name
 */
export async function copySkills(containerName) {
  if (!existsSync(HOST_SKILLS_DIR)) {
    return; // No skills directory on host
  }

  try {
    const skills = readdirSync(HOST_SKILLS_DIR, { withFileTypes: true });
    if (skills.length === 0) {
      return; // Skills directory exists but is empty
    }

    // Create skills directory in container
    await runCapture('docker', [
      'exec', containerName,
      'mkdir', '-p', CONTAINER_SKILLS_DIR,
    ]);

    // Copy entire skills directory (preserves subdirectories)
    await runCapture('docker', [
      'cp', `${HOST_SKILLS_DIR}/.`,
      `${containerName}:${CONTAINER_SKILLS_DIR}/`,
    ]);

    // Fix ownership
    await runCapture('docker', [
      'exec', containerName,
      'chown', '-R', 'node:node', CONTAINER_SKILLS_DIR,
    ]);

    const skillCount = skills.length;
    const plural = skillCount === 1 ? '' : 's';
    log(`Copied ${skillCount} skill${plural} from host ${DIM}(~/.claude/skills)${RESET}`);
  } catch {
    // Non-fatal — skills are optional
  }
}
