// attach + detach subcommands

import { resolve, basename, join } from 'node:path';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runCapture, runInherit, commandExists } from './exec.mjs';
import { log, err, BOLD, DIM, YELLOW, CYAN, RESET } from './colors.mjs';
import { findContainer, getContainerWorkspace, getExtraMountSources, teardown, startContainer } from './container.mjs';
import { generateExtraDirsYamlForAttach } from './compose.mjs';
import { workspaceId, workspaceDataDir } from './workspace-id.mjs';

function isDirectory(p) {
  try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => { rl.close(); res(answer); });
  });
}

export async function attach(repoDir, args, workspace) {
  if (!args[0] || !isDirectory(args[0])) {
    err('Usage: moat attach <directory>');
    process.exit(1);
  }

  const attachDir = resolve(args[0]);
  const attachName = basename(attachDir);
  const hash = workspaceId(workspace);
  const wsDataDir = workspaceDataDir(hash);
  const containerName = await findContainer(workspace);

  if (!containerName) {
    err("No running moat container. Start a session first with 'moat'.");
    process.exit(1);
  }

  if (commandExists('mutagen')) {
    // --- Live-sync via Mutagen ---

    // Check for existing session
    const existing = await runCapture('mutagen', [
      'sync', 'list', '--label-selector', `moat=true,moat-dir=${attachName}`
    ], { allowFailure: true });

    if (existing.stdout.includes('Name:')) {
      err(`A sync session for '${attachName}' already exists. Detach it first with:`);
      err(`  moat detach ${attachName}`);
      process.exit(1);
    }

    // Create target directory inside container
    await runCapture('docker', ['exec', containerName, 'mkdir', '-p', `/extra/${attachName}`]);
    await runCapture('docker', ['exec', containerName, 'chown', 'node:node', `/extra/${attachName}`]);

    // Create mutagen sync session
    await runInherit('mutagen', [
      'sync', 'create',
      '--name', `moat-${attachName}`,
      '--label', 'moat=true',
      '--label', `moat-dir=${attachName}`,
      '--sync-mode', 'two-way-resolved',
      '--default-owner-beta', 'node',
      '--default-group-beta', 'node',
      '--ignore-vcs',
      attachDir,
      `docker://${containerName}/extra/${attachName}`,
    ]);

    // Update per-workspace path mappings so the proxy can resolve the new /extra/ path
    const mapFile = join(wsDataDir, 'path-mappings.json');
    let mappings = {};
    try {
      if (existsSync(mapFile)) {
        mappings = JSON.parse(readFileSync(mapFile, 'utf-8'));
      }
    } catch {}
    mappings[`/extra/${attachName}`] = attachDir;
    writeFileSync(mapFile, JSON.stringify(mappings) + '\n');

    log(`Attached ${BOLD}${attachDir}${RESET} -> ${BOLD}/extra/${attachName}${RESET} (live-sync)`);
    log(`Tell Claude about it: ${DIM}"I have an additional directory at /extra/${attachName}"${RESET}`);
  } else {
    // --- Fallback: restart container with new bind mount ---

    log(`${YELLOW}mutagen not installed — falling back to container restart.${RESET}`);
    log(`This will ${BOLD}end the current Claude session${RESET}.`);
    log(`For live-sync without restarting: ${DIM}brew install mutagen-io/mutagen/mutagen${RESET}`);
    console.log('');

    const answer = await prompt(`  ${CYAN}?${RESET} Restart container to add ${BOLD}/extra/${attachName}${RESET}? ${DIM}[y/N]${RESET} `);
    if (!/^y(es)?$/i.test(answer)) {
      log('Aborted.');
      return;
    }

    const attachWorkspace = await getContainerWorkspace(containerName);
    const existingSources = await getExtraMountSources(containerName);

    const overrideFile = `${wsDataDir}/docker-compose.extra-dirs.yml`;
    writeFileSync(overrideFile, generateExtraDirsYamlForAttach(existingSources, attachDir, attachName));

    // Recreate container
    log('Stopping container...');
    await teardown(workspace);

    log('Starting container with new mount...');
    await startContainer(attachWorkspace, repoDir, wsDataDir, `moat-${hash}`);

    log(`Container restarted with ${BOLD}/extra/${attachName}${RESET}`);
    log(`Resume your session: ${BOLD}moat --resume${RESET}`);
  }
}

export async function detach(args) {
  if (!commandExists('mutagen')) {
    err('mutagen is not installed.');
    process.exit(1);
  }

  if (!args[0]) {
    err('Usage: moat detach <dir|--all>');
    process.exit(1);
  }

  if (args[0] === '--all') {
    await runCapture('mutagen', ['sync', 'terminate', '--label-selector', 'moat=true'], { allowFailure: true });
    log('All moat sync sessions terminated.');
  } else {
    const detachName = basename(args[0]);
    const result = await runCapture('mutagen', [
      'sync', 'terminate', '--label-selector', `moat=true,moat-dir=${detachName}`
    ], { allowFailure: true });

    if (result.exitCode !== 0) {
      err(`No sync session found for '${detachName}'.`);
      process.exit(1);
    }
    log(`Detached ${detachName}`);
  }
}
