// down subcommand — tear down containers + conditionally stop proxy

import { writeSync } from 'node:fs';
import { basename } from 'node:path';
import { log, err, BOLD, DIM, CYAN, RESET } from './colors.mjs';
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

const CLEAR_LINE = '\x1b[2K';
const CURSOR_UP = (n) => n > 0 ? `\x1b[${n}A` : '';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * Render the interactive session list and return selected session or 'all'.
 * Returns null if the user cancels.
 */
function interactiveSelect(sessions) {
  return new Promise((resolve) => {
    let cursor = 0;
    // Items: each session + "[all sessions]" at the end
    const itemCount = sessions.length + 1;
    // Total rendered lines = header blank + items + blank + hint = items + 3
    const totalLines = itemCount + 3;
    let firstRender = true;

    function render() {
      const lines = [];
      lines.push('');
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const wsName = basename(s.workspace || '') || s.name;
        if (i === cursor) {
          lines.push(`  ${CYAN}${BOLD}> ${wsName}${RESET}  ${DIM}${s.name}${RESET}`);
        } else {
          lines.push(`    ${wsName}  ${DIM}${s.name}${RESET}`);
        }
      }
      // "[all sessions]" entry
      const allIdx = sessions.length;
      if (cursor === allIdx) {
        lines.push(`  ${CYAN}${BOLD}> [all sessions]${RESET}`);
      } else {
        lines.push(`    ${DIM}[all sessions]${RESET}`);
      }
      lines.push('');
      lines.push(`  ${DIM}\u2191/\u2193 navigate \u00b7 enter select \u00b7 q quit${RESET}`);

      // Move cursor up to overwrite previous render (skip on first render)
      let out = '';
      if (!firstRender) {
        out += CURSOR_UP(totalLines);
      }
      for (const line of lines) {
        out += CLEAR_LINE + line + '\n';
      }
      writeSync(1, out);
      firstRender = false;
    }

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.removeListener('data', onKey);
      process.stdin.pause();
      writeSync(1, SHOW_CURSOR);
    }

    function onKey(buf) {
      const key = buf.toString();

      // Ctrl+C
      if (key === '\x03') {
        cleanup();
        // Clear the menu
        writeSync(1, CURSOR_UP(totalLines));
        for (let i = 0; i < totalLines; i++) writeSync(1, CLEAR_LINE + '\n');
        writeSync(1, CURSOR_UP(totalLines));
        resolve(null);
        return;
      }

      // q / Q / Escape
      if (key === 'q' || key === 'Q' || key === '\x1b') {
        // Escape sequences for arrow keys start with \x1b[ so only treat bare \x1b as quit
        if (key === '\x1b') {
          // Wait briefly to distinguish bare Escape from arrow key sequence
          // Arrow keys send \x1b[A etc. — if we got just \x1b, it's bare Escape
          // But in raw mode we might get the full sequence in one chunk, so check length
          if (buf.length === 1) {
            cleanup();
            writeSync(1, CURSOR_UP(totalLines));
            for (let i = 0; i < totalLines; i++) writeSync(1, CLEAR_LINE + '\n');
            writeSync(1, CURSOR_UP(totalLines));
            resolve(null);
            return;
          }
          // Otherwise fall through — could be arrow key
        } else {
          cleanup();
          writeSync(1, CURSOR_UP(totalLines));
          for (let i = 0; i < totalLines; i++) writeSync(1, CLEAR_LINE + '\n');
          writeSync(1, CURSOR_UP(totalLines));
          resolve(null);
          return;
        }
      }

      // Arrow up: \x1b[A
      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + itemCount) % itemCount;
        render();
        return;
      }

      // Arrow down: \x1b[B
      if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % itemCount;
        render();
        return;
      }

      // Enter
      if (key === '\r' || key === '\n') {
        cleanup();
        // Clear the menu
        writeSync(1, CURSOR_UP(totalLines));
        for (let i = 0; i < totalLines; i++) writeSync(1, CLEAR_LINE + '\n');
        writeSync(1, CURSOR_UP(totalLines));
        if (cursor === sessions.length) {
          resolve('all');
        } else {
          resolve(sessions[cursor]);
        }
        return;
      }
    }

    log('Running sessions:\n');
    writeSync(1, HIDE_CURSOR);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
    render();
  });
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

  // No explicit workspace or pattern — try interactive picker
  if (!workspace) {
    const running = await findMoatContainers();
    if (running.length === 0) {
      err('No running moat sessions.');
      return;
    }

    // Non-TTY: fall back to listing sessions
    if (!process.stdin.isTTY) {
      log('No workspace specified. Use --all to tear down all moat containers.');
      return;
    }

    const selected = await interactiveSelect(running);
    if (!selected) return; // user cancelled

    if (selected === 'all') {
      // Reuse --all logic
      return down(repoDir, { all: true });
    }

    log(`Tearing down ${BOLD}${basename(selected.workspace || '')}${RESET} (${selected.name})...`);
    await teardown(selected.workspace);

    if (!await anyMoatContainersRunning()) {
      await stopProxy();
    }

    log('Done.');
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
