// `moat audit` subcommand — view session audit logs
// Usage: moat audit [hash] [--type <prefix>] [--last <n>] [--json] [--tail]

import { existsSync, readdirSync, readFileSync, statSync, watchFile, unwatchFile, createReadStream } from 'node:fs';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { readAuditLog } from './audit.mjs';
import { log, err, DIM, RESET } from './colors.mjs';

const DATA_DIR = join(process.env.HOME, '.moat', 'data');
const WORKSPACES_DIR = join(DATA_DIR, 'workspaces');

/**
 * Handle `moat audit [hash] [--type <prefix>] [--last <n>] [--json] [--tail]`.
 * With no hash: lists workspaces that have audit logs.
 * With a hash: displays events for that workspace.
 * With --tail: live-follow mode (like tail -f).
 */
export async function auditView(args) {
  // Parse flags
  let typeFilter = null;
  let lastN = null;
  let jsonOutput = false;
  let tailMode = false;
  let hash = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' && i + 1 < args.length) {
      typeFilter = args[++i];
    } else if (args[i] === '--last' && i + 1 < args.length) {
      lastN = parseInt(args[++i], 10);
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (args[i] === '--tail' || args[i] === '-f') {
      tailMode = true;
    } else if (!args[i].startsWith('-')) {
      hash = args[i];
    }
  }

  // No hash — list workspaces with audit logs
  if (!hash) {
    if (!existsSync(WORKSPACES_DIR)) {
      log('No audit logs found.');
      return;
    }

    const entries = readdirSync(WORKSPACES_DIR, { withFileTypes: true });
    const withLogs = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const auditPath = join(WORKSPACES_DIR, entry.name, 'audit.jsonl');
      if (existsSync(auditPath)) {
        const events = readAuditLog(join(WORKSPACES_DIR, entry.name));
        const sessionStarts = events.filter(e => e.type === 'session.start');
        const lastSession = sessionStarts[sessionStarts.length - 1];
        withLogs.push({
          hash: entry.name,
          events: events.length,
          workspace: lastSession?.workspace || 'unknown',
          lastActivity: events.length > 0 ? events[events.length - 1].ts : null,
        });
      }
    }

    if (withLogs.length === 0) {
      log('No audit logs found.');
      return;
    }

    if (jsonOutput) {
      console.log(JSON.stringify(withLogs, null, 2));
      return;
    }

    log('Workspaces with audit logs:\n');
    for (const w of withLogs) {
      const workspace = basename(w.workspace);
      const time = w.lastActivity ? formatTimestamp(w.lastActivity) : 'no activity';
      console.log(`  ${w.hash}  ${workspace}  ${DIM}${w.events} events, last: ${time}${RESET}`);
    }
    return;
  }

  // Hash provided — show events
  const auditDir = join(WORKSPACES_DIR, hash);
  if (!existsSync(join(auditDir, 'audit.jsonl'))) {
    // Try partial hash match
    if (existsSync(WORKSPACES_DIR)) {
      const entries = readdirSync(WORKSPACES_DIR, { withFileTypes: true });
      const matches = entries.filter(e => e.isDirectory() && e.name.startsWith(hash));
      if (matches.length === 1) {
        return auditView([matches[0].name, ...args.slice(1)]);
      }
      if (matches.length > 1) {
        err(`Ambiguous hash '${hash}' — matches: ${matches.map(m => m.name).join(', ')}`);
        return;
      }
    }
    err(`No audit log found for workspace '${hash}'`);
    return;
  }

  if (tailMode) {
    await tailAuditLog(auditDir, { typeFilter, jsonOutput });
    return;
  }

  const events = readAuditLog(auditDir, { type: typeFilter, last: lastN });

  if (jsonOutput) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  if (events.length === 0) {
    log('No matching events.');
    return;
  }

  for (const event of events) {
    console.log(formatEvent(event));
  }
}

/**
 * Live-follow audit log (like tail -f).
 * Uses fs.watchFile with polling (more portable than fs.watch across platforms/docker).
 */
async function tailAuditLog(auditDir, { typeFilter, jsonOutput }) {
  const auditPath = join(auditDir, 'audit.jsonl');

  // Print existing events first
  const events = readAuditLog(auditDir, { type: typeFilter });
  for (const event of events) {
    if (jsonOutput) {
      console.log(JSON.stringify(event));
    } else {
      console.log(formatEvent(event));
    }
  }

  // Remember the current file size as our read offset
  let offset = 0;
  try {
    if (existsSync(auditPath)) {
      offset = statSync(auditPath).size;
    }
  } catch {}

  log('Watching for new events... (Ctrl+C to stop)');

  // Read new lines from the current offset
  function readNewLines() {
    try {
      const currentSize = statSync(auditPath).size;
      if (currentSize <= offset) {
        // File was truncated/rotated — reset to beginning
        if (currentSize < offset) offset = 0;
        return;
      }

      const stream = createReadStream(auditPath, { start: offset, encoding: 'utf-8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let newOffset = offset;

      rl.on('line', (line) => {
        newOffset += Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (typeFilter && (!event.type || !event.type.startsWith(typeFilter))) return;
          if (jsonOutput) {
            console.log(JSON.stringify(event));
          } else {
            console.log(formatEvent(event));
          }
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', () => {
        offset = newOffset;
      });
    } catch {
      // File might not exist yet — that's fine
    }
  }

  // Poll for changes using fs.watchFile (500ms interval)
  watchFile(auditPath, { interval: 500 }, () => {
    readNewLines();
  });

  // Keep the process alive until Ctrl+C
  return new Promise((resolve) => {
    process.on('SIGINT', () => {
      unwatchFile(auditPath);
      resolve();
    });
  });
}

function formatTimestamp(ts) {
  try {
    return ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  } catch {
    return ts;
  }
}

function formatEvent(event) {
  const time = formatTimestamp(event.ts);
  const type = event.type;

  switch (type) {
    case 'session.start':
      return `${time}  ${type}  workspace=${event.workspace || '?'} runtime=${event.runtime || 'claude'} version=${event.moat_version || '?'}`;
    case 'session.end':
      return `${time}  ${type}  exit_code=${event.exit_code} duration=${event.duration_ms}ms`;
    case 'tool.execute': {
      const summary = event.args_summary || '';
      return `${time}  ${type}  ${event.endpoint} ${summary} -> exit ${event.exit_code} (${event.duration_ms}ms)`;
    }
    case 'tool.blocked':
      return `${time}  ${type}  ${event.endpoint} ${event.args_summary || ''} BLOCKED: ${event.reason}`;
    case 'secrets.detected':
      return `${time}  ${type}  ${event.endpoint} pattern=${event.pattern} phase=${event.scan_phase} action=${event.action}`;
    case 'agent.spawn':
      return `${time}  ${type}  id=${event.agent_id} name=${event.name || '?'}`;
    case 'agent.done':
      return `${time}  ${type}  id=${event.agent_id} status=${event.status} exit_code=${event.exit_code}`;
    default:
      return `${time}  ${type}  ${JSON.stringify(event)}`;
  }
}
