// Copy skills from host ~/.claude/skills/ into container
// Skills are user-created commands that extend Claude Code functionality

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { log, err, DIM, RESET } from './colors.mjs';

const HOST_SKILLS_DIR = join(process.env.HOME, '.claude', 'skills');
const CONTAINER_SKILLS_DIR = '/home/node/.claude/skills';

const HOST_COMMANDS_DIR = join(process.env.HOME, '.claude', 'commands');
const CONTAINER_COMMANDS_DIR = '/home/node/.claude/commands';

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
      'exec', '-u', 'root', containerName,
      'mkdir', '-p', CONTAINER_SKILLS_DIR,
    ]);

    // Copy each entry individually, resolving symlinks so docker cp gets real content.
    for (const entry of skills) {
      const src = join(HOST_SKILLS_DIR, entry.name);
      let realSrc;
      try {
        realSrc = realpathSync(src);
      } catch {
        err(`Skipping skill '${entry.name}': symlink target not found`);
        continue;
      }
      const stat = statSync(realSrc);
      const dest = `${containerName}:${CONTAINER_SKILLS_DIR}/${entry.name}`;
      if (stat.isDirectory()) {
        await runCapture('docker', [
          'exec', '-u', 'root', containerName,
          'mkdir', '-p', `${CONTAINER_SKILLS_DIR}/${entry.name}`,
        ]);
        await runCapture('docker', ['cp', `${realSrc}/.`, `${containerName}:${CONTAINER_SKILLS_DIR}/${entry.name}/`]);
      } else {
        await runCapture('docker', ['cp', realSrc, dest]);
      }
    }

    // Fix ownership
    await runCapture('docker', [
      'exec', '-u', 'root', containerName,
      'chown', '-R', 'node:node', CONTAINER_SKILLS_DIR,
    ]);

    const skillCount = skills.length;
    const plural = skillCount === 1 ? '' : 's';
    log(`Copied ${skillCount} skill${plural} from host ${DIM}(~/.claude/skills)${RESET}`);
  } catch (e) {
    err(`Failed to copy skills: ${e.result?.stderr?.trim() || e.message}`);
  }
}

/**
 * Copy commands from host ~/.claude/commands/ into the container.
 * @param {string} containerName — Docker container name
 */
export async function copyCommands(containerName) {
  if (!existsSync(HOST_COMMANDS_DIR)) {
    return; // No commands directory on host
  }

  try {
    const commands = readdirSync(HOST_COMMANDS_DIR, { withFileTypes: true });
    if (commands.length === 0) {
      return; // Commands directory exists but is empty
    }

    // Create commands directory in container
    await runCapture('docker', [
      'exec', '-u', 'root', containerName,
      'mkdir', '-p', CONTAINER_COMMANDS_DIR,
    ]);

    // Copy each entry individually, resolving symlinks so docker cp gets real content.
    for (const entry of commands) {
      const src = join(HOST_COMMANDS_DIR, entry.name);
      let realSrc;
      try {
        realSrc = realpathSync(src);
      } catch {
        err(`Skipping command '${entry.name}': symlink target not found`);
        continue;
      }
      const stat = statSync(realSrc);
      const dest = `${containerName}:${CONTAINER_COMMANDS_DIR}/${entry.name}`;
      if (stat.isDirectory()) {
        await runCapture('docker', [
          'exec', containerName,
          'mkdir', '-p', `${CONTAINER_COMMANDS_DIR}/${entry.name}`,
        ]);
        await runCapture('docker', ['cp', `${realSrc}/.`, `${containerName}:${CONTAINER_COMMANDS_DIR}/${entry.name}/`]);
      } else {
        await runCapture('docker', ['cp', realSrc, dest]);
      }
    }

    // Fix ownership
    await runCapture('docker', [
      'exec', containerName,
      'chown', '-R', 'node:node', CONTAINER_COMMANDS_DIR,
    ]);

    const commandCount = commands.length;
    const plural = commandCount === 1 ? '' : 's';
    log(`Copied ${commandCount} command${plural} from host ${DIM}(~/.claude/commands)${RESET}`);
  } catch (e) {
    err(`Failed to copy commands: ${e.result?.stderr?.trim() || e.message}`);
  }
}
