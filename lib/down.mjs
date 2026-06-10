// down subcommand — tear down session containers + conditionally stop proxy

import { basename } from 'node:path';
import { log, err, BOLD, DIM, RESET } from './colors.mjs';
import { commandExists, runCapture } from './exec.mjs';
import { teardownSession, findMoatContainers, findSessionContainer } from './container.mjs';
import { workspaceId, sanitizeSessionName } from './workspace-id.mjs';
import { selectFromList } from './select.mjs';
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

function sessionLabel(c) {
  const wsName = basename(c.workspace || '') || c.name;
  return c.session ? `${wsName} (${c.session})` : wsName;
}

async function terminateMutagenSessions() {
  if (commandExists('mutagen')) {
    await runCapture('mutagen', ['sync', 'terminate', '--label-selector', 'moat=true'], { allowFailure: true });
  }
}

async function stopProxyIfIdle() {
  if (!await anyMoatContainersRunning()) {
    await stopProxy();
  }
}

export async function down(repoDir, { all = false, workspace, pattern, name = null } = {}) {
  // --name <label>: stop one named session for this workspace
  if (name) {
    let suffix;
    try {
      suffix = sanitizeSessionName(name);
    } catch (e) {
      err(e.message);
      return;
    }
    const project = `moat-${workspaceId(workspace)}-${suffix}`;
    const container = await findSessionContainer(project);
    if (!container) {
      err(`No running session named '${suffix}' for this workspace.`);
      return;
    }
    log(`Tearing down session ${BOLD}${suffix}${RESET} (${container})...`);
    await teardownSession(container);
    await stopProxyIfIdle();
    log('Done.');
    return;
  }

  // --all: stop every session for this workspace
  if (all) {
    const sessions = (await findMoatContainers()).filter(c => c.workspace === workspace);
    if (sessions.length === 0) {
      err(`No running sessions for ${workspace}.`);
      log(`Tip: 'moat down <pattern>' matches sessions in any workspace ('*' for all).`);
      return;
    }
    log(`Tearing down ${sessions.length} session${sessions.length === 1 ? '' : 's'} for ${BOLD}${basename(workspace)}${RESET}...`);
    await terminateMutagenSessions();
    for (const c of sessions) {
      log(`  ${DIM}${c.name}${RESET}`);
      await teardownSession(c.name);
    }
    await stopProxyIfIdle();
    log('Done.');
    return;
  }

  // Pattern matching — match against workspace path basename, container name,
  // or session name (e.g. moat down myapp, moat down session1, moat down '*')
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

    const matches = running.filter(c => {
      const wsBase = basename(c.workspace || '');
      return regex.test(wsBase) || regex.test(c.workspace || '') || regex.test(c.name)
        || (c.session && regex.test(c.session));
    });

    if (matches.length === 0) {
      // Try substring match as fallback
      const lower = pattern.toLowerCase().replace(/\*/g, '');
      const subMatches = running.filter(c => {
        const wsBase = basename(c.workspace || '').toLowerCase();
        return wsBase.includes(lower) || c.name.toLowerCase().includes(lower)
          || (c.session && c.session.toLowerCase().includes(lower));
      });

      if (subMatches.length === 0) {
        err(`No sessions matching '${pattern}'.`);
        log(`Running sessions:`);
        for (const c of running) {
          console.log(`  ${DIM}${c.name}${RESET}  ${sessionLabel(c)}`);
        }
        return;
      }

      matches.push(...subMatches);
    }

    for (const c of matches) {
      log(`Tearing down ${BOLD}${sessionLabel(c)}${RESET} [${c.name}]...`);
      await teardownSession(c.name);
    }

    await stopProxyIfIdle();
    log('Done.');
    return;
  }

  // No flags: prefer sessions for the current workspace
  const running = await findMoatContainers();
  if (running.length === 0) {
    err('No running moat sessions.');
    return;
  }
  const forWorkspace = running.filter(c => c.workspace === workspace);
  const candidates = forWorkspace.length > 0 ? forWorkspace : running;

  // Only tear down without prompting when the single match unambiguously
  // belongs to the current workspace — never a global-fallback match.
  if (forWorkspace.length === 1) {
    const c = forWorkspace[0];
    log(`Tearing down ${BOLD}${sessionLabel(c)}${RESET}...`);
    await terminateMutagenSessions();
    await teardownSession(c.name);
    await stopProxyIfIdle();
    log('Done.');
    return;
  }

  // Non-TTY: list what's running instead of prompting
  if (!process.stdin.isTTY) {
    log(forWorkspace.length > 0
      ? 'Multiple sessions running. Specify a pattern, --name, or --all.'
      : 'No sessions for this workspace. Specify a pattern or --name to stop sessions elsewhere:');
    for (const c of candidates) {
      console.log(`  ${DIM}${c.name}${RESET}  ${sessionLabel(c)}`);
    }
    return;
  }

  const labels = candidates.map(c => `${sessionLabel(c)}  ${DIM}${c.name}${RESET}`);
  const choice = await selectFromList(labels, {
    title: 'Running sessions:',
    extraOption: '[all sessions]',
  });
  if (choice === null) return; // user cancelled

  const selected = choice === -1 ? candidates : [candidates[choice]];
  await terminateMutagenSessions();
  for (const c of selected) {
    log(`Tearing down ${BOLD}${sessionLabel(c)}${RESET}...`);
    await teardownSession(c.name);
  }
  await stopProxyIfIdle();
  log('Done.');
}
