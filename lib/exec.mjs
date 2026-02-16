// child_process wrappers — zero dependencies

import { spawn, execSync } from 'node:child_process';

/**
 * Run a command, capture stdout/stderr, return { stdout, stderr, exitCode }.
 * Throws on non-zero exit unless opts.allowFailure is set.
 */
export function runCapture(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (exitCode) => {
      const result = { stdout, stderr, exitCode: exitCode ?? 1 };
      if (exitCode !== 0 && !opts.allowFailure) {
        const e = new Error(`${cmd} exited with ${exitCode}`);
        e.result = result;
        reject(e);
      } else {
        resolve(result);
      }
    });
    proc.on('error', (error) => {
      const result = { stdout, stderr: error.message, exitCode: 1 };
      if (!opts.allowFailure) {
        const e = new Error(`${cmd} failed: ${error.message}`);
        e.result = result;
        reject(e);
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Run a command with stdio inherited (user sees output directly).
 * Returns the exit code.
 */
export function runInherit(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: 'inherit',
      shell: false,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    proc.on('close', (exitCode) => resolve(exitCode ?? 1));
    proc.on('error', () => resolve(1));
  });
}

/**
 * Run a command in the background, return the ChildProcess.
 */
export function runBackground(cmd, args = [], opts = {}) {
  return spawn(cmd, args, {
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: false,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
}

/**
 * Synchronous command execution — returns stdout string or null on failure.
 */
export function runSync(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if a command exists on PATH.
 */
export function commandExists(cmd) {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}
