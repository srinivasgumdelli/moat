// Argument parsing — workspace, --add-dir, subcommands, claude args

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Parse argv into { subcommand, workspace, extraDirs, claudeArgs, subcommandArgs }.
 *
 * Subcommands: doctor, update, down, attach, detach, plan, uninstall, init
 * Everything else flows to claude as arguments.
 */
export function parseArgs(argv) {
  const args = argv.slice(2); // strip node + script path

  // Subcommands that take raw args (no workspace parsing needed)
  const rawSubcommands = new Set([
    'doctor', 'update', 'down', 'attach', 'detach', 'uninstall',
  ]);

  // Subcommands that accept workspace + --add-dir (same as main flow)
  const workspaceSubcommands = new Set(['plan', 'init']);

  // Raw subcommands: pass remaining args through unchanged
  if (args.length > 0 && rawSubcommands.has(args[0])) {
    return {
      subcommand: args[0],
      subcommandArgs: args.slice(1),
      workspace: process.cwd(),
      extraDirs: [],
      claudeArgs: [],
    };
  }

  // Detect workspace-aware subcommands, then parse workspace/extraDirs below
  let subcommand = null;
  let rest = args;

  if (rest.length > 0 && workspaceSubcommands.has(rest[0])) {
    subcommand = rest[0];
    rest = rest.slice(1);
  }

  // First arg is workspace path if it's a directory
  let workspace = process.cwd();

  if (rest.length > 0 && isDirectory(rest[0])) {
    workspace = resolve(rest[0]);
    rest = rest.slice(1);
  }

  // Parse --add-dir flags and collect remaining claude args
  const extraDirs = [];
  const claudeArgs = [];

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--add-dir') {
      i++;
      if (i < rest.length && isDirectory(rest[i])) {
        extraDirs.push(resolve(rest[i]));
      } else {
        throw new Error('--add-dir requires a valid directory path');
      }
    } else {
      claudeArgs.push(rest[i]);
    }
  }

  return { subcommand, subcommandArgs: [], workspace, extraDirs, claudeArgs };
}

function isDirectory(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}
