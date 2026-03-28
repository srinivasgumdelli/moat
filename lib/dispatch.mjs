// Headless dispatch — spawn a writable agent directly via tool-proxy
// Used by `moat dispatch <workspace> <task> --headless`

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';
import { PROXY_PORT } from './proxy.mjs';
import { log, err, DIM, RESET } from './colors.mjs';

const WORKTREES_DIR = join(process.env.HOME, '.moat', 'worktrees');

/**
 * Create a git worktree for an isolated dispatch task.
 * @param {string} wsHash - workspace hash
 * @param {string} workspace - host workspace absolute path
 * @returns {{ worktreePath: string, branchName: string }}
 */
export async function createWorktree(wsHash, workspace) {
  const timestamp = Date.now();
  const branchName = `moat/task-${timestamp}`;
  const worktreePath = join(WORKTREES_DIR, wsHash, `task-${timestamp}`);
  mkdirSync(join(WORKTREES_DIR, wsHash), { recursive: true });
  await runCapture('git', ['-C', workspace, 'worktree', 'add', '-b', branchName, worktreePath]);
  return { worktreePath, branchName };
}

/**
 * Remove a git worktree created for dispatch.
 * @param {string} workspace - host workspace absolute path
 * @param {string} worktreePath - path to the worktree to remove
 */
export async function removeWorktree(workspace, worktreePath) {
  await runCapture('git', ['-C', workspace, 'worktree', 'remove', '--force', worktreePath], {
    allowFailure: true,
  });
}

/**
 * Make an authenticated HTTP request to tool-proxy.
 */
function proxyRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PROXY_PORT,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(data
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Run a task headlessly: spawn a writable agent in an isolated git worktree.
 * Waits for the agent to complete and prints its output.
 *
 * @param {string} wsHash - workspace hash
 * @param {string} workspace - host workspace absolute path
 * @param {string} token - tool-proxy bearer token
 * @param {string} task - prompt / task description for the agent
 * @param {object} [opts]
 * @param {string} [opts.model] - optional model override (e.g. 'claude-haiku-4-5-20251001')
 * @param {string} [opts.tools] - comma-separated tool list (default: full write access set)
 * @returns {object} agent result ({ status, exit_code, log })
 */
export async function runHeadlessDispatch(wsHash, workspace, token, task, opts = {}) {
  const tools =
    opts.tools || 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task';

  // Create an isolated git worktree so the agent has full write access
  // without touching the live workspace branch
  let worktreePath, branchName;
  try {
    ({ worktreePath, branchName } = await createWorktree(wsHash, workspace));
    log(`Created worktree ${DIM}(${branchName})${RESET}`);
  } catch (e) {
    err(`Failed to create worktree: ${e.message}`);
    throw e;
  }

  try {
    // Spawn the agent with a writable mount on the worktree
    const spawnResp = await proxyRequest('POST', '/agent/spawn', token, {
      prompt: task,
      workspace_hash: wsHash,
      worktree_path: worktreePath,
      writable: true,
      tools,
      ...(opts.model ? { model: opts.model } : {}),
    });

    if (!spawnResp.body?.success) {
      throw new Error(spawnResp.body?.error || 'Agent spawn failed');
    }

    const agentId = spawnResp.body.id;
    log(`Agent spawned ${DIM}(${agentId})${RESET}`);

    // Wait for agent completion — tool-proxy /agent/wait polls up to 5 min per call
    // Loop to handle the per-call timeout while the agent is still running
    let result;
    for (;;) {
      const waitResp = await proxyRequest(
        'GET',
        `/agent/wait/${agentId}?workspace_hash=${wsHash}`,
        token,
        null,
      );
      result = waitResp.body;
      if (result?.error === 'Timeout waiting for agent.') {
        log('Agent still running, continuing to wait...');
        continue;
      }
      break;
    }

    if (result?.log) {
      process.stdout.write(result.log);
    }

    if (result?.status === 'done') {
      log('Agent completed successfully.');
    } else {
      err(`Agent exited with status: ${result?.status ?? 'unknown'} (exit code: ${result?.exit_code})`);
    }

    return result;
  } finally {
    // Always clean up the worktree, even on failure
    await removeWorktree(workspace, worktreePath);
    log(`Cleaned up worktree ${DIM}(${branchName})${RESET}`);
  }
}
