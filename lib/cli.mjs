// Argument parsing — workspace, --add-dir, subcommands, claude args

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Parse argv into { subcommand, workspace, extraDirs, claudeArgs, subcommandArgs }.
 *
 * Subcommands: doctor, update, down, stop, attach, detach, uninstall, init
 * Everything else flows to claude as arguments.
 */
export function parseArgs(argv) {
  const args = argv.slice(2); // strip node + script path

  // Subcommands that take raw args (no workspace parsing needed)
  const rawSubcommands = new Set([
    'doctor', 'update', 'down', 'stop', 'attach', 'detach', 'uninstall', 'allow-domain',
  ]);

  // Subcommands that accept workspace + --add-dir (same as main flow)
  const workspaceSubcommands = new Set(['init']);

  // All known subcommands (for validation)
  const allSubcommands = new Set([...rawSubcommands, ...workspaceSubcommands]);

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

  // Reject unknown subcommands (args that look like commands but aren't directories or flags)
  if (rest.length > 0 && !subcommand && !rest[0].startsWith('-') && !isDirectory(rest[0])) {
    const suggestion = rest[0];
    const known = [...allSubcommands].sort().join(', ');
    throw new Error(`Unknown command: ${suggestion}\nAvailable commands: ${known}`);
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
