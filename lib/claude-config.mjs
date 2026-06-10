// Read host Claude Code configuration (~/.claude/settings*.json)

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read the model configured in the host's Claude settings.
 * settings.local.json takes precedence over settings.json.
 * Returns null when no model is configured.
 */
export function readHostModel(homeDir = process.env.HOME) {
  const model = readHostAgentSettings(homeDir).model;
  return typeof model === 'string' && model.trim() ? model : null;
}

// Keys that make sense for a headless agent run. Hooks, statusline,
// permissions, and MCP servers are excluded — they reference host paths or
// are moat-managed inside containers.
const AGENT_SETTINGS_KEYS = ['model', 'alwaysThinkingEnabled', 'effortLevel'];

/**
 * Build sanitized agent settings from the host's Claude config.
 * settings.local.json overlays settings.json; only headless-relevant
 * keys are kept. Returns {} when nothing applies.
 */
export function readHostAgentSettings(homeDir = process.env.HOME) {
  const merged = {};
  for (const file of ['settings.json', 'settings.local.json']) {
    try {
      const p = join(homeDir, '.claude', file);
      if (!existsSync(p)) continue;
      Object.assign(merged, JSON.parse(readFileSync(p, 'utf-8')));
    } catch {
      // unreadable/invalid file — skip it
    }
  }
  const out = {};
  for (const key of AGENT_SETTINGS_KEYS) {
    if (merged[key] !== undefined) out[key] = merged[key];
  }
  return out;
}
