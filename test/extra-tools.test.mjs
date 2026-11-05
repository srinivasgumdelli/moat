// Unit tests for .moat.yml extra_tools parsing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    assert.deepEqual(loadExtraTools(ws), { uv: ['ruff', 'my-tool[extras]==1.2.0'], npm: ['prettier'] });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('missing .moat.yml or section yields empty lists', () => {
  const empty = parseExtraTools({});
  assert.deepEqual(empty, { uv: [], npm: [] });
  assert.equal(hasExtraTools(empty), false);
  assert.deepEqual(loadExtraTools('/nonexistent-moat-dir'), { uv: [], npm: [] });
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
  const cmds = installCommands({ uv: ['ruff', 'my-tool[extras]'], npm: ['prettier'] });
  assert.equal(cmds[0][0], 'sh');
  assert.match(cmds[0][2], /command -v uv/);
  assert.deepEqual(cmds.slice(1), [
    ['uv', 'tool', 'install', 'ruff'],
    ['uv', 'tool', 'install', 'my-tool[extras]'],
    ['npm', 'install', '-g', 'prettier'],
  ]);
});

test('installCommands skips uv bootstrap when only npm tools are listed', () => {
  assert.deepEqual(installCommands({ uv: [], npm: ['prettier'] }), [['npm', 'install', '-g', 'prettier']]);
});

test('toolsHash is stable and changes when the list changes', () => {
  const a = toolsHash({ uv: ['ruff'], npm: [] });
  assert.equal(a, toolsHash({ uv: ['ruff'], npm: [] }));
  assert.notEqual(a, toolsHash({ uv: ['ruff', 'black'], npm: [] }));
  assert.notEqual(a, toolsHash({ uv: [], npm: ['ruff'] }));
});
