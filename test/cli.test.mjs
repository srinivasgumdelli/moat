// Unit tests for argument parsing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/cli.mjs';

const argv = (...rest) => ['node', 'moat.mjs', ...rest];

test('parseArgs extracts --name in main flow', () => {
  const p = parseArgs(argv('--name', 'session1'));
  assert.equal(p.sessionName, 'session1');
  assert.deepEqual(p.claudeArgs, []);
});

test('parseArgs --name with workspace and claude args', () => {
  const p = parseArgs(argv('/tmp', '--name', 'dev1', '--resume'));
  assert.equal(p.workspace, '/tmp');
  assert.equal(p.sessionName, 'dev1');
  assert.deepEqual(p.claudeArgs, ['--resume']);
});

test('parseArgs --name without value throws', () => {
  assert.throws(() => parseArgs(argv('--name')));
});

test('parseArgs no --name leaves sessionName null', () => {
  const p = parseArgs(argv());
  assert.equal(p.sessionName, null);
});

test('parseArgs treats attach as raw subcommand', () => {
  const p = parseArgs(argv('attach', '--name', 'session1'));
  assert.equal(p.subcommand, 'attach');
  assert.deepEqual(p.subcommandArgs, ['--name', 'session1']);
});
