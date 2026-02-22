// Tool proxy lifecycle — start, stop, health check

import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { runBackground, runCapture, commandExists } from './exec.mjs';
import { log, err } from './colors.mjs';

import { join as pathJoin } from 'node:path';

const PROXY_PIDFILE = '/tmp/moat-tool-proxy.pid';
const DATA_DIR = pathJoin(process.env.HOME, '.moat', 'data');
const PROXY_LOG = pathJoin(DATA_DIR, 'proxy.log');

export { PROXY_LOG };

/**
 * Check if tool proxy is healthy on :9876.
 */
export function proxyHealthy() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:9876/health', { timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Stop any running tool proxy + mutagen sync sessions.
 */
export async function stopProxy() {
  log('Stopping tool proxy...');

  // Terminate mutagen sessions
  if (commandExists('mutagen')) {
    await runCapture('mutagen', ['sync', 'terminate', '--label-selector', 'moat=true'], { allowFailure: true });
  }

  // Kill by pidfile
  if (existsSync(PROXY_PIDFILE)) {
    try {
      const pid = readFileSync(PROXY_PIDFILE, 'utf8').trim();
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      // process already dead
    }
    try { unlinkSync(PROXY_PIDFILE); } catch {}
  }

  // Kill anything still on :9876
  await runCapture('lsof', ['-ti', ':9876'], { allowFailure: true })
    .then(r => {
      const pids = r.stdout.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try { process.kill(Number(pid), 'SIGTERM'); } catch {}
      }
    })
    .catch(() => {});
}

/**
 * Synchronous cleanup — for use in process 'exit' handler where async is not available.
 */
export function stopProxySync() {
  log('Stopping tool proxy...');

  if (commandExists('mutagen')) {
    try { execSync('mutagen sync terminate --label-selector moat=true', { stdio: 'pipe' }); } catch {}
  }

  if (existsSync(PROXY_PIDFILE)) {
    try {
      const pid = readFileSync(PROXY_PIDFILE, 'utf8').trim();
      process.kill(Number(pid), 'SIGTERM');
    } catch {}
    try { unlinkSync(PROXY_PIDFILE); } catch {}
  }

  try {
    const pids = execSync('lsof -ti :9876', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    for (const pid of pids.split('\n').filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch {}
    }
  } catch {}
}

/**
 * Start the tool proxy. Returns true on success.
 */
export async function startProxy(repoDir, dataDir, opts = {}) {
  const healthy = await proxyHealthy();
  if (healthy) {
    log('Tool proxy already running');
    return true;
  }

  // Kill stale proxy
  await stopProxy().catch(() => {});

  log('Starting tool proxy...');
  const logFd = openSync(PROXY_LOG, 'a');

  const proxyArgs = [
    join(repoDir, 'tool-proxy.mjs'),
    '--data-dir', dataDir,
  ];
  if (opts.workspace) {
    proxyArgs.push('--workspace', opts.workspace);
  }

  const child = runBackground('node', proxyArgs, {
    stdio: ['ignore', logFd, logFd],
    detached: true,
    env: {
      ...process.env,
      MOAT_TOKEN_FILE: join(dataDir, '.proxy-token'),
      GPG_TTY: '',
    },
  });

  closeSync(logFd);
  writeFileSync(PROXY_PIDFILE, String(child.pid));

  // Wait for proxy to be ready (up to 3s)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    // Check process is still alive
    try { process.kill(child.pid, 0); } catch {
      err('Tool proxy failed to start:');
      try { process.stderr.write(readFileSync(PROXY_LOG, 'utf8')); } catch {}
      return false;
    }
    if (await proxyHealthy()) {
      log(`Tool proxy running (PID ${child.pid})`);
      // Unref so the child doesn't keep node alive after exec
      child.unref();
      return true;
    }
  }

  err('Tool proxy did not become healthy within 3s');
  return false;
}
