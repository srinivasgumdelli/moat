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

// Keys moat manages inside containers — the same exclusions copySettings
// (lib/settings.mjs) applies for the devcontainer. Hooks are excluded because
// host hook scripts don't exist in the agent image.
const MOAT_MANAGED_KEYS = ['hooks', 'mcpServers', 'permissions', '$schema'];

const CONTAINER_CLAUDE_DIR = '/home/node/.claude';

function rewriteClaudeHomePath(p, hostClaudeDir) {
  if (typeof p !== 'string') return p;
  if (p === hostClaudeDir) return CONTAINER_CLAUDE_DIR;
  if (p.startsWith(hostClaudeDir + '/')) {
    return CONTAINER_CLAUDE_DIR + p.slice(hostClaudeDir.length);
  }
  return p;
}

/**
 * Build agent settings from the host's Claude config: the full host settings
 * (settings.local.json overlays settings.json) minus moat-managed keys, with
 * ~/.claude paths rewritten to the container equivalent — the same treatment
 * copySettings gives the devcontainer. Returns {} when nothing applies.
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
  for (const key of MOAT_MANAGED_KEYS) {
    delete merged[key];
  }
  const hostClaudeDir = join(homeDir, '.claude');
  for (const key of ['statusLine', 'subagentStatusLine']) {
    const cmd = merged?.[key]?.command;
    if (typeof cmd === 'string') {
      merged[key].command = rewriteClaudeHomePath(cmd, hostClaudeDir);
    }
  }
  return merged;
}
