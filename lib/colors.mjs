// Terminal colors and logging — disabled when stdout is not a TTY

import { writeSync } from 'node:fs';

const isTTY = process.stdout.isTTY;

export const BOLD   = isTTY ? '\x1b[1m'    : '';
export const DIM    = isTTY ? '\x1b[2m'    : '';
export const RED    = isTTY ? '\x1b[0;31m' : '';
export const GREEN  = isTTY ? '\x1b[0;32m' : '';
export const YELLOW = isTTY ? '\x1b[0;33m' : '';
export const CYAN   = isTTY ? '\x1b[0;36m' : '';
export const RESET  = isTTY ? '\x1b[0m'    : '';

export function log(msg) {
  writeSync(1, `${CYAN}[moat]${RESET} ${msg}\n`);
}

export function err(msg) {
  writeSync(2, `${RED}[moat]${RESET} ${msg}\n`);
}
