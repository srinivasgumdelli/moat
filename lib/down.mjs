// down subcommand — tear down containers + conditionally stop proxy

import { basename } from 'node:path';
import { log, err, BOLD, DIM, RESET } from './colors.mjs';
import { commandExists, runCapture } from './exec.mjs';
import { teardown, findMoatContainers } from './container.mjs';
import { stopProxy } from './proxy.mjs';

/**
 * Check if any moat containers are still running.
 */
async function anyMoatContainersRunning() {
  try {
    const result = await runCapture('docker', [
      'ps', '--filter', 'name=moat-', '--format', '{{.Names}}'
    ], { allowFailure: true });
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function down(repoDir, { all = false, workspace, pattern } = {}) {
  if (all) {
    log('Tearing down all moat containers...');

    if (commandExists('mutagen')) {
      await runCapture('mutagen', ['sync', 'terminate', '--label-selector', 'moat=true'], { allowFailure: true });
    }

    // Find and stop all moat-* containers (devcontainers + agents)
    try {
      const result = await runCapture('docker', [
        'ps', '-a', '--filter', 'name=moat-', '--format', '{{.Names}}'
      ], { allowFailure: true });
      const containers = result.stdout.trim().split('\n').filter(Boolean);
      for (const name of containers) {
        await runCapture('docker', ['rm', '-f', name], { allowFailure: true });
      }
    } catch {}

    await stopProxy();
    log('Done.');
    return;
  }

  // Pattern matching — match against workspace path basename or container name
  if (pattern) {
    const running = await findMoatContainers();
    if (running.length === 0) {
      err('No running moat sessions.');
      return;
    }

    // Build a glob-like matcher (supports * as wildcard)
    const regex = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      'i'
    );

    // Match against: workspace basename, full workspace path, container name
    const matches = running.filter(c => {
      const wsBase = basename(c.workspace || '');
      return regex.test(wsBase) || regex.test(c.workspace || '') || regex.test(c.name);
    });

    if (matches.length === 0) {
      // Try substring match as fallback
      const lower = pattern.toLowerCase().replace(/\*/g, '');
      const subMatches = running.filter(c => {
        const wsBase = basename(c.workspace || '').toLowerCase();
        return wsBase.includes(lower) || c.name.toLowerCase().includes(lower);
      });

      if (subMatches.length === 0) {
        err(`No sessions matching '${pattern}'.`);
        log(`Running sessions:`);
        for (const c of running) {
          console.log(`  ${DIM}${c.name}${RESET}  ${basename(c.workspace || '')}`);
        }
        return;
      }

      // Use substring matches
      matches.push(...subMatches);
    }

    for (const c of matches) {
      log(`Tearing down ${BOLD}${basename(c.workspace || '')}${RESET} (${c.name})...`);
      await teardown(c.workspace);
    }

    if (!await anyMoatContainersRunning()) {
      await stopProxy();
    }

    log('Done.');
    return;
  }

  // Workspace-scoped teardown (default: current directory)
  if (!workspace) {
    log('No workspace specified. Use --all to tear down all moat containers.');
    return;
  }

  log(`Tearing down container for workspace ${workspace}...`);

  if (commandExists('mutagen')) {
    await runCapture('mutagen', ['sync', 'terminate', '--label-selector', 'moat=true'], { allowFailure: true });
  }

  await teardown(workspace);

  // Only kill proxy if no other moat containers are running
  if (!await anyMoatContainersRunning()) {
    await stopProxy();
  }

  log('Done.');
}
