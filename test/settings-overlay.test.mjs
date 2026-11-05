// Unit tests for the .moat.yml Claude settings overlay
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSettingsOverlay, loadSettingsOverlay, deepMerge, overlayJqExpr, SettingsOverlayError,
} from '../lib/settings-overlay.mjs';
import { jqUpdateCommand } from '../lib/mcp-servers.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'moat-overlay-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('deepMerge merges objects recursively and replaces arrays', () => {
  assert.deepEqual(
    deepMerge({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2], e: 3 } }),
    { a: { b: 1, c: [2], e: 3 }, d: 1 },
  );
});

test('inline claude_settings from .moat.yml is parsed and env values become strings', () => {
  withDir((ws) => {
    writeFileSync(join(ws, '.moat.yml'), [
      'claude_settings:',
      '  autoCompactWindow: 400000',
      '  bashOutputMaxChars: 60000',
      '  env:',
      '    MY_FLAG: 1',
      '    MY_MODE: "fast"',
      '',
    ].join('\n'));
    const { settings, dropped } = loadSettingsOverlay(ws, ws);
    assert.deepEqual(settings, {
      autoCompactWindow: 400000,
      bashOutputMaxChars: 60000,
      env: { MY_FLAG: '1', MY_MODE: 'fast' },
    });
    assert.deepEqual(dropped, []);
  });
});

test('claude_settings_file is read and inline claude_settings wins over it', () => {
  withDir((ws) => {
    writeFileSync(join(ws, 'overlay.json'), JSON.stringify({ autoCompactWindow: 1, env: { A: 'file', B: 'file' } }));
    const { settings, sources } = buildSettingsOverlay({
      claude_settings_file: 'overlay.json',
      claude_settings: { autoCompactWindow: 2, env: { B: 'inline' } },
    }, ws, ws);
    assert.deepEqual(settings, { autoCompactWindow: 2, env: { A: 'file', B: 'inline' } });
    assert.deepEqual(sources, ['overlay.json', 'claude_settings']);
  });
});

test('claude_settings_file expands ~/ against the home directory', () => {
  withDir((home) => {
    writeFileSync(join(home, 'shared.json'), JSON.stringify({ bashOutputMaxChars: 5 }));
    const { settings } = buildSettingsOverlay({ claude_settings_file: '~/shared.json' }, '/nonexistent', home);
    assert.deepEqual(settings, { bashOutputMaxChars: 5 });
  });
});

test('moat-managed keys are dropped from the overlay', () => {
  const { settings, dropped } = buildSettingsOverlay({
    claude_settings: {
      hooks: { Stop: [] },
      mcpServers: { x: {} },
      $schema: 'x',
      permissions: { defaultMode: 'plan', deny: ['Bash(rm:*)'] },
      editorMode: 'vim',
    },
  }, '/tmp');
  assert.deepEqual(settings, { permissions: { deny: ['Bash(rm:*)'] }, editorMode: 'vim' });
  assert.deepEqual(dropped.sort(), ['$schema', 'hooks', 'mcpServers', 'permissions.defaultMode']);
});

test('permissions is removed entirely when defaultMode was its only key', () => {
  const { settings } = buildSettingsOverlay({ claude_settings: { permissions: { defaultMode: 'plan' } } }, '/tmp');
  assert.deepEqual(settings, {});
});

test('invalid JSON in claude_settings_file fails with a clear message', () => {
  withDir((ws) => {
    writeFileSync(join(ws, 'bad.json'), '{ "a": 1,, }');
    assert.throws(
      () => buildSettingsOverlay({ claude_settings_file: 'bad.json' }, ws, ws),
      (e) => e instanceof SettingsOverlayError && /not valid JSON/.test(e.message) && e.message.includes('bad.json'),
    );
  });
});

test('missing claude_settings_file fails', () => {
  assert.throws(
    () => buildSettingsOverlay({ claude_settings_file: 'nope.json' }, '/tmp', '/tmp'),
    (e) => e instanceof SettingsOverlayError && /not found/.test(e.message),
  );
});

test('non-object JSON and non-mapping claude_settings fail', () => {
  withDir((ws) => {
    writeFileSync(join(ws, 'arr.json'), '[1,2]');
    assert.throws(() => buildSettingsOverlay({ claude_settings_file: 'arr.json' }, ws, ws), SettingsOverlayError);
  });
  assert.throws(() => buildSettingsOverlay({ claude_settings: 'autoCompactWindow' }, '/tmp'), SettingsOverlayError);
  assert.throws(() => buildSettingsOverlay({ claude_settings: { env: ['A=1'] } }, '/tmp'), SettingsOverlayError);
});

test('no .moat.yml or no overlay keys yields an empty overlay', () => {
  withDir((ws) => {
    assert.deepEqual(loadSettingsOverlay(ws, ws).settings, {});
    writeFileSync(join(ws, '.moat.yml'), 'docker: true\n');
    assert.deepEqual(loadSettingsOverlay(ws, ws).settings, {});
  });
});

test('jq overlay deep-merges into an existing settings file and keeps other keys', () => {
  withDir((dir) => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({
      permissions: { allow: ['Bash(x:*)'], defaultMode: 'bypassPermissions' },
      env: { KEEP: 'yes' },
      model: 'm',
    }));
    const expr = overlayJqExpr({ autoCompactWindow: 400000, env: { NEW: "it's 1" }, permissions: { deny: ['Bash(y:*)'] } });
    execFileSync('/bin/sh', ['-c', jqUpdateCommand(file, expr)], { stdio: 'pipe' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      permissions: { allow: ['Bash(x:*)'], defaultMode: 'bypassPermissions', deny: ['Bash(y:*)'] },
      env: { KEEP: 'yes', NEW: "it's 1" },
      model: 'm',
      autoCompactWindow: 400000,
    });
  });
});
