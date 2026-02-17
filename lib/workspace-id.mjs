// Workspace identity — hash workspace path to scope all resources per-workspace

import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Return first 8 hex chars of SHA-256 hash of the absolute workspace path.
 */
export function workspaceId(absPath) {
  return createHash('sha256').update(absPath).digest('hex').slice(0, 8);
}

/**
 * Return the per-workspace data directory: ~/.moat/data/workspaces/<hash>/
 */
export function workspaceDataDir(hash) {
  return join(process.env.HOME, '.moat', 'data', 'workspaces', hash);
}
