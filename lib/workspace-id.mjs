// Workspace identity — hash workspace path to scope all resources per-workspace

import { createHash, randomBytes } from 'node:crypto';
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

/**
 * Random 4-hex-char session suffix (e.g. "a3f2").
 */
export function randomSessionSuffix() {
  return randomBytes(2).toString('hex');
}

/**
 * Sanitize a user-provided --name label into a compose-project-safe suffix.
 * Throws if nothing safe remains.
 */
export function sanitizeSessionName(label) {
  const safe = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (!safe || !/^[a-z0-9][a-z0-9_-]*$/.test(safe)) {
    throw new Error(`Invalid session name '${label}' — use letters, numbers, hyphens.`);
  }
  return safe;
}

/**
 * Full per-session identifier: <wsHash8>-<suffix>.
 * Used as data dir name, compose project suffix, and MOAT_WORKSPACE_HASH.
 */
export function sessionId(absPath, suffix) {
  return `${workspaceId(absPath)}-${suffix}`;
}
