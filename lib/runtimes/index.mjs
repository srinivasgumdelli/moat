// Runtime registry — pluggable architecture for multiple coding assistants

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '../yaml.mjs';

import claude from './claude.mjs';
import codex from './codex.mjs';
import opencode from './opencode.mjs';
import amp from './amp.mjs';

const RUNTIMES = {
  claude,
  codex,
  opencode,
  amp,
};

/**
 * Get a runtime config by name.
 * @param {string} name — runtime name (e.g. 'claude', 'codex')
 * @returns {object} runtime config
 * @throws if runtime is unknown
 */
export function getRuntime(name) {
  const runtime = RUNTIMES[name];
  if (!runtime) {
    const known = Object.keys(RUNTIMES).join(', ');
    throw new Error(`Unknown runtime: ${name} (available: ${known})`);
  }
  return runtime;
}

/**
 * List all available runtime names.
 * @returns {string[]}
 */
export function listRuntimes() {
  return Object.keys(RUNTIMES);
}

/**
 * Resolve runtime name from CLI flag, .moat.yml config, or default.
 * Priority: --runtime flag > .moat.yml runtime: field > 'claude'
 * @param {string|null} cliFlag — value of --runtime flag (null if not provided)
 * @param {string} workspace — workspace directory path
 * @returns {string} resolved runtime name
 */
export function resolveRuntimeName(cliFlag, workspace) {
  if (cliFlag) return cliFlag;

  // Check .moat.yml for runtime: field
  const moatYml = join(workspace, '.moat.yml');
  if (existsSync(moatYml)) {
    try {
      const content = readFileSync(moatYml, 'utf-8');
      const config = parseYaml(content);
      if (config.runtime && typeof config.runtime === 'string') {
        return config.runtime;
      }
    } catch {
      // Ignore parse errors — fall through to default
    }
  }

  return 'claude';
}
