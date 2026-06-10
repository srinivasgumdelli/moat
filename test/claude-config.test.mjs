// Unit tests for host Claude config reading
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readHostModel, readHostAgentSettings } from '../lib/claude-config.mjs';

function makeHome(settings, localSettings) {
  const home = mkdtempSync(join(tmpdir(), 'moat-test-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  if (settings !== undefined) {
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  if (localSettings !== undefined) {
    writeFileSync(join(home, '.claude', 'settings.local.json'), JSON.stringify(localSettings));
  }
  return home;
}

test('readHostModel returns model from settings.json', () => {
  const home = makeHome({ model: 'claude-fable-5[1m]' });
  try {
    assert.equal(readHostModel(home), 'claude-fable-5[1m]');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readHostModel prefers settings.local.json over settings.json', () => {
  const home = makeHome({ model: 'claude-opus-4-8' }, { model: 'claude-haiku-4-5-20251001' });
  try {
    assert.equal(readHostModel(home), 'claude-haiku-4-5-20251001');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readHostModel returns null when no model is configured', () => {
  const home = makeHome({ editorMode: 'vim' });
  try {
    assert.equal(readHostModel(home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readHostAgentSettings forwards full host settings minus moat-managed keys', () => {
  const home = makeHome({
    model: 'claude-fable-5[1m]',
    alwaysThinkingEnabled: true,
    effortLevel: 'high',
    editorMode: 'vim',
    hooks: { Stop: [{ command: '/Users/someone/.claude/hook.sh' }] },
    permissions: { defaultMode: 'plan' },
    mcpServers: { example: {} },
    $schema: 'https://example.invalid/schema.json',
  });
  try {
    assert.deepEqual(readHostAgentSettings(home), {
      model: 'claude-fable-5[1m]',
      alwaysThinkingEnabled: true,
      effortLevel: 'high',
      editorMode: 'vim',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readHostAgentSettings rewrites statusline paths to container paths', () => {
  const home = makeHome({});
  try {
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: join(home, '.claude', 'statusline.sh') },
    }));
    assert.deepEqual(readHostAgentSettings(home), {
      statusLine: { type: 'command', command: '/home/node/.claude/statusline.sh' },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readHostAgentSettings returns {} when nothing applies', () => {
  const home = makeHome({ hooks: {} });
  try {
    assert.deepEqual(readHostAgentSettings(home), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readHostModel returns null when settings files are missing or invalid', () => {
  const home = mkdtempSync(join(tmpdir(), 'moat-test-home-'));
  try {
    assert.equal(readHostModel(home), null);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), 'not json');
    assert.equal(readHostModel(home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
