// Unit tests for .moat.yml extra_tools parsing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  parseExtraTools, loadExtraTools, installCommands, toolsHash, hasExtraTools, ExtraToolsError,
} from '../lib/extra-tools.mjs';

test('extra_tools is parsed from .moat.yml, including quoted extras specs', () => {
  const ws = mkdtempSync(join(tmpdir(), 'moat-tools-'));
  try {
    writeFileSync(join(ws, '.moat.yml'), [
      'extra_tools:',
      '  uv:',
      '    - ruff',
      '    - "my-tool[extras]==1.2.0"',
      '  npm:',
      '    - prettier',
      '',
    ].join('\n'));
    assert.deepEqual(loadExtraTools(ws), { uv: ['ruff', 'my-tool[extras]==1.2.0'], npm: ['prettier'], go: [] });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('missing .moat.yml or section yields empty lists', () => {
  const empty = parseExtraTools({});
  assert.deepEqual(empty, { uv: [], npm: [], go: [] });
  assert.equal(hasExtraTools(empty), false);
  assert.deepEqual(loadExtraTools('/nonexistent-moat-dir'), { uv: [], npm: [], go: [] });
});

test('unsupported installer and bad entries are rejected', () => {
  assert.throws(() => parseExtraTools({ extra_tools: { brew: ['x'] } }), ExtraToolsError);
  assert.throws(() => parseExtraTools({ extra_tools: ['ruff'] }), ExtraToolsError);
  assert.throws(() => parseExtraTools({ extra_tools: { uv: 'ruff' } }), ExtraToolsError);
  assert.throws(() => parseExtraTools({ extra_tools: { uv: ['--index-url=http://x'] } }), /not flags/);
  assert.throws(() => parseExtraTools({ extra_tools: { uv: ['ruff; rm -rf /'] } }), /not flags/);
  assert.throws(() => parseExtraTools({ extra_tools: { npm: [42] } }), ExtraToolsError);
});

test('installCommands bootstraps uv then installs each spec as separate argv', () => {
  const cmds = installCommands({ uv: ['ruff', 'my-tool[extras]'], npm: ['prettier'], go: [] });
  assert.equal(cmds[0][0], 'sh');
  assert.match(cmds[0][2], /command -v uv/);
  assert.deepEqual(cmds.slice(1), [
    ['uv', 'tool', 'install', 'ruff'],
    ['uv', 'tool', 'install', 'my-tool[extras]'],
    ['npm', 'install', '-g', 'prettier'],
  ]);
});

test('installCommands skips uv bootstrap when only npm tools are listed', () => {
  assert.deepEqual(installCommands({ uv: [], npm: ['prettier'], go: [] }), [['npm', 'install', '-g', 'prettier']]);
});

test('toolsHash is stable and changes when the list changes', () => {
  const a = toolsHash({ uv: ['ruff'], npm: [], go: [] });
  assert.equal(a, toolsHash({ uv: ['ruff'], npm: [], go: [] }));
  assert.notEqual(a, toolsHash({ uv: ['ruff', 'black'], npm: [], go: [] }));
  assert.notEqual(a, toolsHash({ uv: [], npm: ['ruff'], go: [] }));
  assert.notEqual(a, toolsHash({ uv: ['ruff'], npm: [], go: ['example.com/cmd/tool@v1.0.0'] }));
});

test('go entries need a module path with a version and install with go install', () => {
  const tools = parseExtraTools({ extra_tools: { go: ['github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0'] } });
  assert.deepEqual(tools.go, ['github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0']);
  assert.deepEqual(installCommands(tools), [['go', 'install', 'github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0']]);
  assert.throws(() => parseExtraTools({ extra_tools: { go: ['github.com/example/tool'] } }), /with a version/);
  assert.throws(() => parseExtraTools({ extra_tools: { go: ['@v1.0.0'] } }), /with a version/);
  assert.throws(() => parseExtraTools({ extra_tools: { go: ['a@b@c'] } }), /with a version/);
});

test('an existing uv/npm list keeps its hash when the go installer is unused', () => {
  const legacy = createHash('sha256').update(JSON.stringify([['uv', ['ruff']], ['npm', []]])).digest('hex');
  assert.equal(toolsHash({ uv: ['ruff'], npm: [], go: [] }), legacy);
});
