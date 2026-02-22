// Session audit logging — structured event trail for every moat session
// Writes JSON Lines to <auditDir>/audit.jsonl

import { appendFileSync, existsSync, readFileSync, mkdirSync, renameSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_FILES = 3;

/**
 * Rotate audit.jsonl when it exceeds the max size.
 * Rotates: audit.jsonl → audit.1.jsonl → audit.2.jsonl → deleted
 * @param {string} auditDir — directory containing audit.jsonl
 * @param {object} [opts]
 * @param {number} [opts.maxSize] — max file size in bytes (default 5 MB, env: MOAT_AUDIT_MAX_SIZE)
 * @param {number} [opts.maxFiles] — max rotated files to keep (default 3, env: MOAT_AUDIT_MAX_FILES)
 */
export function rotateAuditLog(auditDir, opts = {}) {
  const maxSize = opts.maxSize || parseInt(process.env.MOAT_AUDIT_MAX_SIZE || '', 10) || DEFAULT_MAX_SIZE;
  const maxFiles = opts.maxFiles || parseInt(process.env.MOAT_AUDIT_MAX_FILES || '', 10) || DEFAULT_MAX_FILES;
  const currentPath = join(auditDir, 'audit.jsonl');

  if (!existsSync(currentPath)) return;

  try {
    const stat = statSync(currentPath);
    if (stat.size < maxSize) return;
  } catch {
    return;
  }

  try {
    // Delete the oldest rotated file if it would exceed maxFiles
    const oldestPath = join(auditDir, `audit.${maxFiles - 1}.jsonl`);
    if (existsSync(oldestPath)) {
      unlinkSync(oldestPath);
    }

    // Shift rotated files: audit.2.jsonl → audit.3.jsonl, audit.1.jsonl → audit.2.jsonl, etc.
    for (let i = maxFiles - 2; i >= 1; i--) {
      const from = join(auditDir, `audit.${i}.jsonl`);
      const to = join(auditDir, `audit.${i + 1}.jsonl`);
      if (existsSync(from)) {
        renameSync(from, to);
      }
    }

    // Rotate current file to audit.1.jsonl
    renameSync(currentPath, join(auditDir, 'audit.1.jsonl'));
  } catch {
    // Non-fatal — continue with existing file if rotation fails
  }
}

/**
 * Create an audit logger that writes events to audit.jsonl in the given directory.
 * Rotates the log file if it exceeds the configured max size.
 * @param {string} auditDir — directory to write audit.jsonl (usually wsDir)
 * @returns {{ emit: (type: string, payload: object) => void, path: string }}
 */
export function createAuditLogger(auditDir) {
  mkdirSync(auditDir, { recursive: true });
  rotateAuditLog(auditDir);
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
 * Reads from all rotated files (oldest first) + current file.
 * @param {string} auditDir — directory containing audit.jsonl
 * @param {object} [opts]
 * @param {string} [opts.type] — filter to events whose type starts with this prefix
 * @param {number} [opts.last] — return only the last N events (after filtering)
 * @returns {object[]} — parsed event objects
 */
export function readAuditLog(auditDir, opts = {}) {
  // Collect all audit files: rotated (highest number = oldest) + current
  const files = [];

  // Find rotated files (audit.1.jsonl, audit.2.jsonl, etc.)
  try {
    const entries = readdirSync(auditDir);
    const rotated = entries
      .filter(f => /^audit\.\d+\.jsonl$/.test(f))
      .map(f => ({ name: f, num: parseInt(f.match(/^audit\.(\d+)\.jsonl$/)[1], 10) }))
      .sort((a, b) => b.num - a.num); // Highest number (oldest) first
    for (const r of rotated) {
      files.push(join(auditDir, r.name));
    }
  } catch {
    // Directory might not exist — that's fine
  }

  // Add current file last (newest)
  const currentPath = join(auditDir, 'audit.jsonl');
  if (existsSync(currentPath)) {
    files.push(currentPath);
  }

  if (files.length === 0) return [];

  let events = [];
  for (const file of files) {
    try {
      const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Skip unreadable files
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
