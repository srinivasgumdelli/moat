// down subcommand — tear down containers + conditionally stop proxy

import { log } from './colors.mjs';
import { commandExists, runCapture } from './exec.mjs';
import { teardown } from './container.mjs';
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

export async function down(repoDir, { all = false, workspace } = {}) {
  if (all) {
    log('Tearing down all moat containers...');

    if (commandExists('mutagen')) {
      await runCapture('mutagen', ['sync', 'terminate', '--label-selector', 'moat=true'], { allowFailure: true });
    }

    // Find and stop all moat-* compose projects
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

  // Workspace-scoped teardown
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
