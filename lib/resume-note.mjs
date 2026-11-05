// Resume note from .moat.yml
//
// Long-running Claude Code sessions lose their working context on compaction
// or /clear. With
//   claude_resume_note: path/to/note.md
// Moat adds a SessionStart hook (matcher "clear|compact") to the container's
// ~/.claude/settings.json that prints the note to stdout, so Claude Code
// injects it as context in the fresh session.
//
// The path is relative to the workspace, absolute, or starts with ~/.
// When it lives inside the workspace (or an extra mounted directory) the hook
// reads the live file, so edits take effect without restarting. Otherwise a
// copy is placed in the container at start.
//
// Moat's hook entry is tagged with MARKER in its command. Re-running moat
// replaces it in place; removing the option removes it. Hook entries without
// the marker are never touched.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { runCapture } from './exec.mjs';
import { jqUpdateCommand } from './mcp-servers.mjs';
import { log, DIM, RESET } from './colors.mjs';

const CONTAINER_SETTINGS = '/home/node/.claude/settings.json';
export const CONTAINER_NOTE_COPY = '/home/node/.claude/moat-resume-note.md';
export const MARKER = 'moat-resume-note';
export const MAX_NOTE_BYTES = 8192;
export const HOOK_MATCHER = 'clear|compact';

export class ResumeNoteError extends Error {}

function expandPath(p, workspace, homeDir) {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return join(homeDir, p.slice(2));
  return isAbsolute(p) ? p : resolve(workspace, p);
}

/**
 * Map a host path to where the container sees it, or null when it is not
 * under the workspace (/workspace) or an extra dir (/extra/<name>).
 */
export function containerPathFor(hostPath, workspace, extraDirs = []) {
  const mounts = [[workspace, '/workspace'], ...extraDirs.map((d) => [d, `/extra/${basename(d)}`])];
  for (const [src, dest] of mounts) {
    if (!src) continue;
    if (hostPath.startsWith(src + '/')) return dest + hostPath.slice(src.length);
  }
  return null;
}

/**
 * Resolve claude_resume_note from a parsed .moat.yml config object.
 * Returns null when unset, else { source, hostPath, containerPath, live }.
 * Throws ResumeNoteError with a user-facing message on bad input.
 */
export function buildResumeNote(config, workspace, extraDirs = [], homeDir = process.env.HOME) {
  const value = config?.claude_resume_note;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ResumeNoteError('claude_resume_note must be a path string');
  }
  const hostPath = expandPath(value, workspace, homeDir);
  if (!existsSync(hostPath)) {
    throw new ResumeNoteError(`claude_resume_note not found: ${hostPath}`);
  }
  if (!statSync(hostPath).isFile()) {
    throw new ResumeNoteError(`claude_resume_note is not a file: ${hostPath}`);
  }
  const mapped = containerPathFor(hostPath, workspace, extraDirs);
  return {
    source: value,
    hostPath,
    containerPath: mapped ?? CONTAINER_NOTE_COPY,
    live: mapped !== null,
  };
}

/** Read .moat.yml from the workspace and resolve the resume note (or null). */
export function loadResumeNote(workspace, extraDirs = [], homeDir = process.env.HOME) {
  const cfgPath = join(workspace, '.moat.yml');
  if (!existsSync(cfgPath)) return null;
  const config = parseYaml(readFileSync(cfgPath, 'utf-8'));
  return buildResumeNote(config, workspace, extraDirs, homeDir);
}

function shQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Shell command run by the hook. Prints the note (capped at maxBytes, with a
 * marker when truncated) and always exits 0 so a missing note never blocks
 * the session. The leading no-op carries MARKER so moat can find its entry.
 */
export function hookCommand(containerPath, maxBytes = MAX_NOTE_BYTES) {
  const f = shQuote(containerPath);
  return [
    `: ${MARKER};`,
    `f=${f};`,
    `[ -r "$f" ] || exit 0;`,
    `head -c ${maxBytes} "$f";`,
    `if [ "$(wc -c < "$f")" -gt ${maxBytes} ]; then printf '\\n\\n[resume note truncated at ${maxBytes} bytes]\\n'; fi;`,
    'exit 0',
  ].join(' ');
}

/** The SessionStart hook entry moat manages. */
export function hookEntry(containerPath, maxBytes = MAX_NOTE_BYTES) {
  return {
    matcher: HOOK_MATCHER,
    hooks: [{ type: 'command', command: hookCommand(containerPath, maxBytes), timeout: 10 }],
  };
}

/**
 * jq expression that removes moat's SessionStart entry (identified by MARKER)
 * and, when entry is given, appends it. Other hook entries are left alone;
 * SessionStart / hooks are only deleted when moat's removal emptied them.
 */
export function resumeNoteJqExpr(entry) {
  const strip = [
    'if (.hooks | type) == "object" and (.hooks.SessionStart | type) == "array" then',
    '  (.hooks.SessionStart | length) as $n',
    `  | .hooks.SessionStart |= map(select(((.hooks // []) | map(.command // "" | tostring | contains(${JSON.stringify(MARKER)})) | any) | not))`,
    '  | if (.hooks.SessionStart | length) < $n then',
    '      (if .hooks.SessionStart == [] then del(.hooks.SessionStart) else . end)',
    '      | (if .hooks == {} then del(.hooks) else . end)',
    '    else . end',
    'else . end',
  ].join('\n');
  if (!entry) return `(${strip})`;
  const add = `.hooks = ((if (.hooks | type) == "object" then .hooks else {} end) | .SessionStart = ((if (.SessionStart | type) == "array" then .SessionStart else [] end) + [${JSON.stringify(entry)}]))`;
  return `(${strip}) | ${add}`;
}

/**
 * Install (or remove, when note is null) moat's resume-note hook in the
 * container's settings.json. Copies the note in when it is outside the mounts.
 */
export async function applyResumeNote(containerName, note) {
  try {
    if (note && !note.live) {
      await runCapture('docker', ['cp', note.hostPath, `${containerName}:${CONTAINER_NOTE_COPY}`]);
      await runCapture('docker', ['exec', '-u', 'root', containerName, 'chown', 'node:node', CONTAINER_NOTE_COPY]);
    }
    await runCapture('docker', [
      'exec', containerName,
      'sh', '-c',
      jqUpdateCommand(
        CONTAINER_SETTINGS,
        resumeNoteJqExpr(note ? hookEntry(note.containerPath) : null),
        { skipIfMissing: !note },
      ),
    ]);
    const cleanup = note ? ':' : `rm -f ${CONTAINER_NOTE_COPY}`;
    await runCapture('docker', [
      'exec', '-u', 'root', containerName,
      'sh', '-c', `${cleanup}; [ -e ${CONTAINER_SETTINGS} ] && chown node:node ${CONTAINER_SETTINGS}; exit 0`,
    ]);
    if (note) {
      log(`Resume note hook set ${DIM}(${note.source}${note.live ? ', read live' : ', copied at start'})${RESET}`);
    }
  } catch (e) {
    log(`Failed to apply resume note hook: ${DIM}${e.result?.stderr?.trim() || e.message || e}${RESET}`);
  }
}
