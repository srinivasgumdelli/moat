// down subcommand — tear down containers + stop proxy

import { log } from './colors.mjs';
import { commandExists, runCapture } from './exec.mjs';
import { teardown } from './container.mjs';
import { stopProxy } from './proxy.mjs';

export async function down(repoDir) {
  log('Tearing down containers...');

  if (commandExists('mutagen')) {
    await runCapture('mutagen', ['sync', 'terminate', '--label-selector', 'moat=true'], { allowFailure: true });
  }

  await teardown(repoDir);
  await stopProxy();

  log('Done.');
}
