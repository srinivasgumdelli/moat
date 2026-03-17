// `moat rewind` — list and restore from checkpoint commits and session boundaries.
// Usage: moat rewind [--list] [--to <sha>] [workspace]

import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { readAuditLog } from './audit.mjs';
import { workspaceId, workspaceDataDir } from './workspace-id.mjs';
import { log, err, DIM, RESET } from './colors.mjs';

/**
 * Handle `moat rewind [--list] [--to <sha>] [workspace]`.
 */
export async function rewind(args) {
  let listMode = false;
  let targetSha = null;
  let workspace = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list' || args[i] === '-l') {
      listMode = true;
    } else if (args[i] === '--to' && i + 1 < args.length) {
      targetSha = args[++i];
    } else if (!args[i].startsWith('-')) {
      workspace = args[i];
    }
  }

  // Default to --list if no --to specified
  if (!targetSha) listMode = true;

  if (!existsSync(workspace)) {
    err(`Workspace not found: ${workspace}`);
    return;
  }

  // Check this is a git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    err(`${workspace} is not a git repository`);
    return;
  }

  if (listMode) {
    await listRecoveryPoints(workspace);
  } else {
    await recoverTo(workspace, targetSha);
  }
}

async function listRecoveryPoints(workspace) {
  const points = [];

  // 1. Checkpoint commits from git log
  try {
    const logOutput = execSync(
      'git log --all --oneline --grep="\\[moat-checkpoint\\]" --format="%H %ai %s"',
      { cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (logOutput) {
      for (const line of logOutput.split('\n')) {
        const match = line.match(/^(\S+)\s+(\S+ \S+)\s+\S+\s+(.*)$/);
        if (match) {
          points.push({
            sha: match[1],
            time: match[2],
            type: 'checkpoint',
            message: match[3],
          });
        }
      }
    }
  } catch {}

  // 2. Session boundaries from audit log
  const hash = workspaceId(workspace);
  const auditDir = workspaceDataDir(hash);
  if (existsSync(join(auditDir, 'audit.jsonl'))) {
    const events = readAuditLog(auditDir);
    for (const event of events) {
      if ((event.type === 'session.start' || event.type === 'session.end') && event.head_sha) {
        points.push({
          sha: event.head_sha,
          time: formatAuditTime(event.ts),
          type: event.type === 'session.start' ? 'session-start' : 'session-end',
          message: `${event.type} (runtime=${event.runtime || '?'})`,
        });
      }
    }
  }

  if (points.length === 0) {
    log('No recovery points found.');
    log('Checkpoint commits are created automatically before risky git operations');
    log('and at session end (if there are uncommitted changes).');
    return;
  }

  // Sort by time descending (most recent first)
  points.sort((a, b) => b.time.localeCompare(a.time));

  // Deduplicate by SHA
  const seen = new Set();
  const unique = [];
  for (const p of points) {
    if (!seen.has(p.sha)) {
      seen.add(p.sha);
      unique.push(p);
    }
  }

  log('Recovery points:\n');
  for (const p of unique) {
    const shortSha = p.sha.slice(0, 10);
    const typeLabel = p.type.padEnd(14);
    console.log(`  ${shortSha}  ${p.time}  ${DIM}${typeLabel}${RESET}  ${p.message}`);
  }
  log(`\nTo recover: moat rewind --to <sha>`);
}

async function recoverTo(workspace, sha) {
  // Verify the SHA exists
  try {
    execSync(`git cat-file -e ${sha}`, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    err(`SHA not found: ${sha}`);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branchName = `moat-recovery-${timestamp}`;

  try {
    execSync(`git branch ${branchName} ${sha}`, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
    log(`Created recovery branch: ${branchName}`);
    log(`  Points to: ${sha}`);
    log(`\nTo switch to it: git checkout ${branchName}`);
  } catch (e) {
    err(`Failed to create recovery branch: ${e.message}`);
  }
}

function formatAuditTime(ts) {
  try {
    return ts.replace('T', ' ').replace(/\.\d+Z$/, '').slice(0, 19);
  } catch {
    return ts;
  }
}
