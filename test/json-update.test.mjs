// Unit tests for the safe jq-update shell command builder
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jqUpdateCommand } from '../lib/mcp-servers.mjs';

function withFile(initial, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'moat-jsonupd-'));
  const file = join(dir, '.claude.json');
  if (initial !== undefined) writeFileSync(file, initial);
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCmd(cmd) {
  try {
    execFileSync('/bin/sh', ['-c', cmd], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

test('applies the jq expression to a valid file', () => {
  withFile('{"a":1}', (file) => {
    assert.equal(runCmd(jqUpdateCommand(file, '.mcpServers = {"x":{}}')), 0);
    const out = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(out, { a: 1, mcpServers: { x: {} } });
  });
});

test('recovers from an empty file instead of rewriting it empty', () => {
  withFile('', (file) => {
    assert.equal(runCmd(jqUpdateCommand(file, '.mcpServers = {"x":{}}')), 0);
    const raw = readFileSync(file, 'utf8');
    assert.notEqual(raw.length, 0, 'file must not be left empty');
    assert.deepEqual(JSON.parse(raw), { mcpServers: { x: {} } });
  });
});

test('recovers from an invalid file', () => {
  withFile('{"a":1', (file) => {
    assert.equal(runCmd(jqUpdateCommand(file, '.mcpServers = {}')), 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mcpServers: {} });
  });
});

test('creates the file when missing', () => {
  withFile(undefined, (file) => {
    assert.equal(runCmd(jqUpdateCommand(file, '.mcpServers = {}')), 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mcpServers: {} });
  });
});

test('skipIfMissing leaves a missing file uncreated and succeeds', () => {
  withFile(undefined, (file) => {
    assert.equal(runCmd(jqUpdateCommand(file, 'del(.mcpServers)', { skipIfMissing: true })), 0);
    assert.equal(existsSync(file), false);
  });
});

test('a failing jq expression leaves the original content intact', () => {
  withFile('{"a":1}', (file) => {
    assert.notEqual(runCmd(jqUpdateCommand(file, '.a | broken_fn')), 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1 });
    const leftovers = execFileSync('/bin/sh', ['-c', `ls -a "$(dirname ${file})"`], { encoding: 'utf8' });
    assert.equal(/moat-json/.test(leftovers), false, 'temp file must be cleaned up');
  });
});

test('the file is never observable as truncated (no read-truncate window)', () => {
  // The old `jq f > f` pattern truncated the target before writing. Assert the
  // command writes via a temp file + rename instead.
  withFile('{"a":1}', (file) => {
    const cmd = jqUpdateCommand(file, '.b = 2');
    assert.match(cmd, /mv /, 'must publish the result with an atomic rename');
    assert.equal(runCmd(cmd), 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1, b: 2 });
  });
});

test('single quotes in the jq expression are escaped', () => {
  withFile('{}', (file) => {
    assert.equal(runCmd(jqUpdateCommand(file, `.name = "it's fine"`)), 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { name: "it's fine" });
  });
});
