// Session audit logging — structured event trail for every moat session
// Writes JSON Lines to <auditDir>/audit.jsonl

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Create an audit logger that writes events to audit.jsonl in the given directory.
 * @param {string} auditDir — directory to write audit.jsonl (usually wsDir)
 * @returns {{ emit: (type: string, payload: object) => void, path: string }}
 */
export function createAuditLogger(auditDir) {
  mkdirSync(auditDir, { recursive: true });
  const path = join(auditDir, 'audit.jsonl');

  function emit(type, payload = {}) {
    try {
      const event = { ts: new Date().toISOString(), type, ...payload };
      appendFileSync(path, JSON.stringify(event) + '\n');
    } catch {
      // Non-fatal — never let audit logging break the main flow
    }
  }

  return { emit, path };
}

/**
 * Read and optionally filter events from an audit log.
 * @param {string} auditDir — directory containing audit.jsonl
 * @param {object} [opts]
 * @param {string} [opts.type] — filter to events whose type starts with this prefix
 * @param {number} [opts.last] — return only the last N events (after filtering)
 * @returns {object[]} — parsed event objects
 */
export function readAuditLog(auditDir, opts = {}) {
  const path = join(auditDir, 'audit.jsonl');
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  let events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  if (opts.type) {
    events = events.filter(e => e.type && e.type.startsWith(opts.type));
  }

  if (opts.last && opts.last > 0) {
    events = events.slice(-opts.last);
  }

  return events;
}
