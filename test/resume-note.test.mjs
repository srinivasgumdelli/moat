// Unit tests for the .moat.yml resume note SessionStart hook
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildResumeNote, loadResumeNote, containerPathFor, hookCommand, hookEntry,
  resumeNoteJqExpr, ResumeNoteError, CONTAINER_NOTE_COPY, HOOK_MATCHER, MARKER,
} from '../lib/resume-note.mjs';
import { jqUpdateCommand } from '../lib/mcp-servers.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'moat-resume-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function applyJq(file, entry) {
  execFileSync('/bin/sh', ['-c', jqUpdateCommand(file, resumeNoteJqExpr(entry))], { stdio: 'pipe' });
  return JSON.parse(readFileSync(file, 'utf8'));
}

const USER_HOOK = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] };
const OTHER_HOOK = { matcher: '', hooks: [{ type: 'command', command: 'lint.sh' }] };

test('unset claude_resume_note yields null', () => {
  withDir((ws) => {
    assert.equal(loadResumeNote(ws, [], ws), null);
    writeFileSync(join(ws, '.moat.yml'), 'docker: true\n');
    assert.equal(loadResumeNote(ws, [], ws), null);
  });
});

test('a note inside the workspace is read live from /workspace', () => {
  withDir((ws) => {
    mkdirSync(join(ws, 'notes'));
    writeFileSync(join(ws, 'notes', 'resume.md'), '# state\n');
    writeFileSync(join(ws, '.moat.yml'), 'claude_resume_note: notes/resume.md\n');
    assert.deepEqual(loadResumeNote(ws, [], ws), {
      source: 'notes/resume.md',
      hostPath: join(ws, 'notes', 'resume.md'),
      containerPath: '/workspace/notes/resume.md',
      live: true,
    });
  });
});

test('a note outside the mounts is copied into the container', () => {
  withDir((home) => {
    writeFileSync(join(home, 'note.md'), 'x');
    const note = buildResumeNote({ claude_resume_note: '~/note.md' }, '/nonexistent', [], home);
    assert.equal(note.containerPath, CONTAINER_NOTE_COPY);
    assert.equal(note.live, false);
  });
});

test('container paths map the workspace and extra dirs', () => {
  assert.equal(containerPathFor('/h/ws/a/b.md', '/h/ws', []), '/workspace/a/b.md');
  assert.equal(containerPathFor('/h/other/n.md', '/h/ws', ['/h/other']), '/extra/other/n.md');
  assert.equal(containerPathFor('/h/wsx/n.md', '/h/ws', []), null);
});

test('missing, non-file and non-string notes fail with a clear message', () => {
  withDir((ws) => {
    assert.throws(
      () => buildResumeNote({ claude_resume_note: 'nope.md' }, ws, [], ws),
      (e) => e instanceof ResumeNoteError && /not found/.test(e.message) && e.message.includes('nope.md'),
    );
    mkdirSync(join(ws, 'dir'));
    assert.throws(() => buildResumeNote({ claude_resume_note: 'dir' }, ws, [], ws), /not a file/);
    assert.throws(() => buildResumeNote({ claude_resume_note: ['a'] }, ws, [], ws), ResumeNoteError);
  });
});

test('hook command prints the note, truncates large notes, and tolerates a missing file', () => {
  withDir((dir) => {
    const small = join(dir, "it's small.md");
    writeFileSync(small, 'hello\n');
    assert.equal(execFileSync('/bin/sh', ['-c', hookCommand(small, 16)], { encoding: 'utf8' }), 'hello\n');

    const big = join(dir, 'big.md');
    writeFileSync(big, 'a'.repeat(40));
    const out = execFileSync('/bin/sh', ['-c', hookCommand(big, 16)], { encoding: 'utf8' });
    assert.equal(out, 'a'.repeat(16) + '\n\n[resume note truncated at 16 bytes]\n');

    assert.equal(execFileSync('/bin/sh', ['-c', hookCommand(join(dir, 'gone.md'), 16)], { encoding: 'utf8' }), '');
  });
});

test('hook entry uses the clear|compact matcher and carries the marker', () => {
  const entry = hookEntry('/workspace/n.md');
  assert.equal(entry.matcher, HOOK_MATCHER);
  assert.equal(entry.matcher, 'clear|compact');
  assert.ok(entry.hooks[0].command.includes(MARKER));
});

test('jq adds the hook next to user hooks and is idempotent', () => {
  withDir((dir) => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ model: 'm', hooks: { SessionStart: [USER_HOOK], Stop: [OTHER_HOOK] } }));
    const entry = hookEntry('/workspace/n.md');
    const once = applyJq(file, entry);
    const twice = applyJq(file, entry);
    assert.deepEqual(twice, once);
    assert.deepEqual(twice, { model: 'm', hooks: { SessionStart: [USER_HOOK, entry], Stop: [OTHER_HOOK] } });
  });
});

test('jq replaces an older moat entry when the note path changes', () => {
  withDir((dir) => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{}');
    applyJq(file, hookEntry('/workspace/old.md'));
    const out = applyJq(file, hookEntry('/workspace/new.md'));
    assert.deepEqual(out, { hooks: { SessionStart: [hookEntry('/workspace/new.md')] } });
  });
});

test('jq removal drops only the moat entry and cleans up what it emptied', () => {
  withDir((dir) => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [USER_HOOK] } }));
    applyJq(file, hookEntry('/workspace/n.md'));
    assert.deepEqual(applyJq(file, null), { hooks: { SessionStart: [USER_HOOK] } });

    writeFileSync(file, JSON.stringify({ model: 'm' }));
    applyJq(file, hookEntry('/workspace/n.md'));
    assert.deepEqual(applyJq(file, null), { model: 'm' });
  });
});

test('jq removal leaves user-defined empty hook blocks alone', () => {
  withDir((dir) => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [] } }));
    assert.deepEqual(applyJq(file, null), { hooks: { SessionStart: [] } });
  });
});
