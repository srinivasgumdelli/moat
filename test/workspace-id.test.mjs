// Unit tests for session ID primitives
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceId, sessionId, randomSessionSuffix, sanitizeSessionName } from '../lib/workspace-id.mjs';

test('workspaceId returns stable 8-char hex hash', () => {
  const a = workspaceId('/Users/x/repo');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, workspaceId('/Users/x/repo'));
  assert.notEqual(a, workspaceId('/Users/x/other'));
});

test('randomSessionSuffix returns 4 hex chars and varies', () => {
  const s = randomSessionSuffix();
  assert.match(s, /^[0-9a-f]{4}$/);
  const seen = new Set(Array.from({ length: 20 }, () => randomSessionSuffix()));
  assert.ok(seen.size > 1);
});

test('sessionId appends suffix to workspace hash', () => {
  const id = sessionId('/Users/x/repo', 'a3f2');
  assert.equal(id, `${workspaceId('/Users/x/repo')}-a3f2`);
});

test('sanitizeSessionName lowercases and accepts simple labels', () => {
  assert.equal(sanitizeSessionName('Session1'), 'session1');
  assert.equal(sanitizeSessionName('my-session'), 'my-session');
});

test('sanitizeSessionName strips unsafe chars', () => {
  assert.equal(sanitizeSessionName('my session!'), 'my-session');
});

test('sanitizeSessionName throws on empty/invalid labels', () => {
  assert.throws(() => sanitizeSessionName('!!!'));
  assert.throws(() => sanitizeSessionName(''));
  assert.throws(() => sanitizeSessionName('---'));
});
