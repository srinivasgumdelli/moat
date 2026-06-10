// Generic interactive arrow-key list picker (TTY only)

import { writeSync } from 'node:fs';
import { log, BOLD, DIM, CYAN, RESET } from './colors.mjs';

const CLEAR_LINE = '\x1b[2K';
const CURSOR_UP = (n) => n > 0 ? `\x1b[${n}A` : '';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * Render an interactive list and resolve with the selected item index.
 * If extraOption is given it is rendered as the last entry and selecting it
 * resolves with -1. Cancelling (q / Esc / Ctrl+C) resolves with null.
 *
 * @param {string[]} labels — display label per item (may contain ANSI codes)
 * @param {object} opts
 * @param {string} opts.title — header line printed above the list
 * @param {string|null} opts.extraOption — optional trailing entry (e.g. "[all sessions]")
 * @returns {Promise<number|null>}
 */
export function selectFromList(labels, { title = 'Select:', extraOption = null } = {}) {
  return new Promise((resolve) => {
    let cursor = 0;
    const itemCount = labels.length + (extraOption ? 1 : 0);
    // Total rendered lines = header blank + items + blank + hint = items + 3
    const totalLines = itemCount + 3;
    let firstRender = true;

    function render() {
      const lines = [];
      lines.push('');
      for (let i = 0; i < labels.length; i++) {
        if (i === cursor) {
          lines.push(`  ${CYAN}${BOLD}> ${labels[i]}${RESET}`);
        } else {
          lines.push(`    ${labels[i]}`);
        }
      }
      if (extraOption) {
        const extraIdx = labels.length;
        if (cursor === extraIdx) {
          lines.push(`  ${CYAN}${BOLD}> ${extraOption}${RESET}`);
        } else {
          lines.push(`    ${DIM}${extraOption}${RESET}`);
        }
      }
      lines.push('');
      lines.push(`  ${DIM}↑/↓ navigate · enter select · q quit${RESET}`);

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

    function clearMenu() {
      writeSync(1, CURSOR_UP(totalLines));
      for (let i = 0; i < totalLines; i++) writeSync(1, CLEAR_LINE + '\n');
      writeSync(1, CURSOR_UP(totalLines));
    }

    function onKey(buf) {
      const key = buf.toString();

      // Ctrl+C
      if (key === '\x03') {
        cleanup();
        clearMenu();
        resolve(null);
        return;
      }

      // q / Q / bare Escape (arrow keys arrive as \x1b[A etc. in one chunk)
      if (key === 'q' || key === 'Q' || (key === '\x1b' && buf.length === 1)) {
        cleanup();
        clearMenu();
        resolve(null);
        return;
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
        clearMenu();
        resolve(cursor === labels.length ? -1 : cursor);
        return;
      }
    }

    log(`${title}\n`);
    writeSync(1, HIDE_CURSOR);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
    render();
  });
}
