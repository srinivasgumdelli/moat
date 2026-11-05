// Claude Code settings overlay from .moat.yml
//
// Lets a project pin Claude Code settings (e.g. autoCompactWindow, env vars)
// that are applied to the container's ~/.claude/settings.json on every start,
// so they survive container rebuilds instead of being hand-edited in place.
//
// Two sources, both optional, merged in this order (later wins):
//   claude_settings_file: path to a JSON file (relative to the workspace, or
//                         absolute, or starting with ~/)
//   claude_settings:      inline YAML mapping
//
// The overlay is deep-merged on top of the container settings AFTER the host
// settings merge. Moat-managed keys are never taken from the overlay:
//   hooks, mcpServers, $schema, permissions.defaultMode
// (permissions.defaultMode is re-forced by moat after the overlay is applied).

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { runCapture } from './exec.mjs';
import { jqUpdateCommand } from './mcp-servers.mjs';
import { log, DIM, RESET } from './colors.mjs';

const CONTAINER_SETTINGS = '/home/node/.claude/settings.json';

// Top-level keys the overlay may not set.
export const PROTECTED_KEYS = ['hooks', 'mcpServers', '$schema'];
// Nested keys the overlay may not set, as [parent, child].
export const PROTECTED_NESTED_KEYS = [['permissions', 'defaultMode']];

export class SettingsOverlayError extends Error {}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge: objects merge recursively, everything else (arrays included) is replaced. */
export function deepMerge(base, overlay) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function expandPath(p, workspace, homeDir) {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return join(homeDir, p.slice(2));
  return isAbsolute(p) ? p : resolve(workspace, p);
}

/**
 * Remove moat-managed keys from an overlay. Returns { settings, dropped }
 * where dropped lists the key paths that were ignored.
 */
export function stripProtectedKeys(overlay) {
  const settings = { ...overlay };
  const dropped = [];
  for (const key of PROTECTED_KEYS) {
    if (key in settings) {
      delete settings[key];
      dropped.push(key);
    }
  }
  for (const [parent, child] of PROTECTED_NESTED_KEYS) {
    if (isPlainObject(settings[parent]) && child in settings[parent]) {
      settings[parent] = { ...settings[parent] };
      delete settings[parent][child];
      dropped.push(`${parent}.${child}`);
      if (Object.keys(settings[parent]).length === 0) delete settings[parent];
    }
  }
  return { settings, dropped };
}

/**
 * Claude Code expects env values to be strings. YAML turns `1` into a number
 * and `true` into a boolean, so coerce scalar env values to strings.
 */
function normalizeEnv(settings) {
  if (settings.env === undefined) return settings;
  if (!isPlainObject(settings.env)) {
    throw new SettingsOverlayError('claude_settings: "env" must be a mapping of NAME: value');
  }
  const env = {};
  for (const [k, v] of Object.entries(settings.env)) {
    if (v !== null && typeof v === 'object') {
      throw new SettingsOverlayError(`claude_settings: env.${k} must be a string, number or boolean`);
    }
    env[k] = v === null ? '' : String(v);
  }
  return { ...settings, env };
}

/**
 * Build the settings overlay from a parsed .moat.yml config object.
 * Throws SettingsOverlayError with a user-facing message on bad input.
 * Returns { settings, dropped, sources } (settings is {} when nothing is configured).
 */
export function buildSettingsOverlay(config, workspace, homeDir = process.env.HOME) {
  let merged = {};
  const sources = [];

  const filePath = config?.claude_settings_file;
  if (filePath !== undefined && filePath !== null && filePath !== '') {
    if (typeof filePath !== 'string') {
      throw new SettingsOverlayError('claude_settings_file must be a path string');
    }
    const abs = expandPath(filePath, workspace, homeDir);
    if (!existsSync(abs)) {
      throw new SettingsOverlayError(`claude_settings_file not found: ${abs}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf-8'));
    } catch (e) {
      throw new SettingsOverlayError(`claude_settings_file is not valid JSON (${abs}): ${e.message}`);
    }
    if (!isPlainObject(parsed)) {
      throw new SettingsOverlayError(`claude_settings_file must contain a JSON object (${abs})`);
    }
    merged = deepMerge(merged, parsed);
    sources.push(filePath);
  }

  const inline = config?.claude_settings;
  if (inline !== undefined && inline !== null && inline !== '') {
    if (!isPlainObject(inline)) {
      throw new SettingsOverlayError('claude_settings must be a mapping of Claude Code settings keys');
    }
    merged = deepMerge(merged, inline);
    sources.push('claude_settings');
  }

  const { settings, dropped } = stripProtectedKeys(merged);
  return { settings: normalizeEnv(settings), dropped, sources };
}

/**
 * Read .moat.yml from the workspace and build the overlay.
 * Throws SettingsOverlayError on invalid input.
 */
export function loadSettingsOverlay(workspace, homeDir = process.env.HOME) {
  const cfgPath = join(workspace, '.moat.yml');
  if (!existsSync(cfgPath)) return { settings: {}, dropped: [], sources: [] };
  const config = parseYaml(readFileSync(cfgPath, 'utf-8'));
  return buildSettingsOverlay(config, workspace, homeDir);
}

/** jq expression that deep-merges the overlay into the existing file. */
export function overlayJqExpr(settings) {
  return `. * ${JSON.stringify(settings)}`;
}

/**
 * Deep-merge the overlay into the container's settings.json.
 * Call after the host settings merge and before moat forces its own keys.
 */
export async function applySettingsOverlay(containerName, overlay) {
  const { settings, dropped, sources } = overlay;
  if (dropped.length > 0) {
    log(`Ignoring moat-managed keys in settings overlay ${DIM}(${dropped.join(', ')})${RESET}`);
  }
  if (Object.keys(settings).length === 0) return;
  try {
    await runCapture('docker', [
      'exec', containerName,
      'sh', '-c',
      jqUpdateCommand(CONTAINER_SETTINGS, overlayJqExpr(settings)),
    ]);
    await runCapture('docker', [
      'exec', containerName,
      'chown', 'node:node', CONTAINER_SETTINGS,
    ]);
    log(`Applied Claude settings overlay ${DIM}(${Object.keys(settings).join(', ')} from ${sources.join(' + ')})${RESET}`);
  } catch (e) {
    log(`Failed to apply Claude settings overlay: ${DIM}${e.result?.stderr?.trim() || e.message || e}${RESET}`);
  }
}
