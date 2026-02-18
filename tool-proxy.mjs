#!/usr/bin/env node
// Moat tool proxy — runs on the host, executes commands with host credentials
// Container wrapper scripts proxy gh/git/terraform/kubectl/aws through this server
// Container wrapper scripts send container paths; proxy translates to host paths
// IaC tools (terraform/kubectl/aws) are restricted to read-only operations via allowlists

import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.TOOL_PROXY_PORT || '9876');
const TOKEN_PATH = process.env.MOAT_TOKEN_FILE || join(__dirname, '.proxy-token');
const TOKEN = readFileSync(TOKEN_PATH, 'utf-8').trim();

// Parse --workspace argument (host path that maps to /workspace in container)
const wsIdx = process.argv.indexOf('--workspace');
const HOST_WORKSPACE = wsIdx !== -1 ? process.argv[wsIdx + 1] : null;
if (!HOST_WORKSPACE) {
  process.stderr.write('Usage: tool-proxy.mjs --workspace /path/to/host/workspace\n');
  process.exit(1);
}

// Translate container path to host path
function toHostPath(containerPath) {
  if (!containerPath) return null;
  if (containerPath === '/workspace') return HOST_WORKSPACE;
  if (containerPath.startsWith('/workspace/')) {
    return join(HOST_WORKSPACE, containerPath.slice('/workspace/'.length));
  }
  return containerPath;
}

// --- IaC tool allowlists (plan-only / read-only) ---

const TERRAFORM_ALLOWED = new Set([
  'init', 'plan', 'validate', 'fmt', 'show', 'output', 'graph',
  'providers', 'version', 'workspace', 'state', 'console',
]);
const TERRAFORM_STATE_ALLOWED = new Set(['list', 'show', 'pull']);
const TERRAFORM_WORKSPACE_ALLOWED = new Set(['list', 'show', 'select']);

function validateTerraform(args) {
  if (args.length === 0) return { allowed: true }; // bare `terraform` shows help
  const subcmd = args[0];
  if (subcmd.startsWith('-')) return { allowed: true }; // flags like --version, --help
  if (!TERRAFORM_ALLOWED.has(subcmd)) {
    return { allowed: false, reason: `terraform ${subcmd} is blocked by Moat (plan-only mode)` };
  }
  if (subcmd === 'state' && args[1] && !TERRAFORM_STATE_ALLOWED.has(args[1])) {
    return { allowed: false, reason: `terraform state ${args[1]} is blocked by Moat` };
  }
  if (subcmd === 'workspace' && args[1] && !TERRAFORM_WORKSPACE_ALLOWED.has(args[1])) {
    return { allowed: false, reason: `terraform workspace ${args[1]} is blocked by Moat` };
  }
  return { allowed: true };
}

const KUBECTL_ALLOWED = new Set([
  'get', 'describe', 'logs', 'top', 'api-resources', 'api-versions',
  'cluster-info', 'config', 'version', 'auth', 'diff', 'explain',
  'wait', 'events',
]);
const KUBECTL_CONFIG_ALLOWED = new Set(['view', 'get-contexts', 'current-context', 'get-clusters', 'get-users']);
const KUBECTL_AUTH_ALLOWED = new Set(['can-i', 'whoami']);

function validateKubectl(args) {
  if (args.length === 0) return { allowed: true };
  const subcmd = args[0];
  if (subcmd.startsWith('-')) return { allowed: true };
  if (!KUBECTL_ALLOWED.has(subcmd)) {
    return { allowed: false, reason: `kubectl ${subcmd} is blocked by Moat (read-only mode)` };
  }
  if (subcmd === 'config' && args[1] && !KUBECTL_CONFIG_ALLOWED.has(args[1])) {
    return { allowed: false, reason: `kubectl config ${args[1]} is blocked by Moat` };
  }
  if (subcmd === 'auth' && args[1] && !KUBECTL_AUTH_ALLOWED.has(args[1])) {
    return { allowed: false, reason: `kubectl auth ${args[1]} is blocked by Moat` };
  }
  return { allowed: true };
}

const AWS_BLOCKED_VERBS = new Set([
  'create', 'delete', 'terminate', 'remove', 'put', 'update', 'run',
  'start', 'stop', 'reboot', 'modify', 'release', 'deregister',
  'revoke', 'disable', 'enable', 'attach', 'detach', 'associate',
  'disassociate', 'import', 'export', 'invoke', 'publish', 'send',
  'execute', 'cancel', 'reset', 'restore',
]);

function validateAws(args) {
  if (args.length === 0) return { allowed: true };
  // Find the subcommand (skip flags like --region, --profile)
  const nonFlagArgs = args.filter(a => !a.startsWith('-'));
  if (nonFlagArgs.length < 2) return { allowed: true }; // just service name or help
  const service = nonFlagArgs[0];
  const action = nonFlagArgs[1];
  // Allow sts get-caller-identity, s3 ls, s3api list-buckets, etc.
  // Block based on the verb prefix of the action
  const verb = action.split('-')[0];
  if (AWS_BLOCKED_VERBS.has(verb)) {
    return { allowed: false, reason: `aws ${service} ${action} is blocked by Moat (read-only mode)` };
  }
  return { allowed: true };
}

// Translate file path arguments from container paths to host paths
function translateArgPaths(args) {
  return args.map(arg => {
    if (arg.startsWith('/workspace/') || arg === '/workspace') {
      return toHostPath(arg);
    }
    // Handle -var-file=/workspace/... style flags
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      const val = arg.slice(eqIdx + 1);
      if (val.startsWith('/workspace/') || val === '/workspace') {
        return arg.slice(0, eqIdx + 1) + toHostPath(val);
      }
    }
    return arg;
  });
}

// Cache GitHub token with TTL
let cachedGhToken = null;
let tokenFetchedAt = 0;
const TOKEN_TTL_MS = 10 * 60 * 1000;

function getGitHubToken() {
  if (cachedGhToken && (Date.now() - tokenFetchedAt < TOKEN_TTL_MS)) return cachedGhToken;
  try {
    cachedGhToken = execSync('gh auth token', { encoding: 'utf-8' }).trim();
    tokenFetchedAt = Date.now();
  } catch {
    cachedGhToken = null;
    tokenFetchedAt = 0;
  }
  return cachedGhToken;
}

function verifyAuth(req) {
  if (req.url === '/health') return true;
  return req.headers['authorization'] === `Bearer ${TOKEN}`;
}

function executeCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (exitCode) => {
      resolve({ success: exitCode === 0, stdout, stderr, exitCode: exitCode ?? 1 });
    });
    proc.on('error', (err) => {
      resolve({ success: false, stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (!verifyAuth(req)) {
    sendJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  if (req.url === '/health' && req.method === 'GET') {
    sendJson(res, 200, { success: true });
    return;
  }

  // gh handler
  if (req.url === '/gh' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.args)) {
      sendJson(res, 400, { success: false, error: 'Invalid request: args required' });
      return;
    }
    const ghToken = getGitHubToken();
    const env = {};
    if (ghToken) { env.GITHUB_TOKEN = ghToken; env.GH_TOKEN = ghToken; }
    const options = { env };
    const hostCwd = toHostPath(body.cwd);
    if (hostCwd && existsSync(hostCwd)) options.cwd = hostCwd;
    const result = await executeCommand('gh', body.args, options);
    process.stderr.write(`[tool-proxy] gh ${body.args.join(' ')} -> exit ${result.exitCode}\n`);
    sendJson(res, 200, result);
    return;
  }

  // git handler
  if (req.url === '/git' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.args)) {
      sendJson(res, 400, { success: false, error: 'Invalid request: args required' });
      return;
    }
    if (!body.cwd) {
      sendJson(res, 400, { success: false, error: 'Invalid request: cwd required' });
      return;
    }
    const hostCwd = toHostPath(body.cwd);
    if (!existsSync(hostCwd)) {
      sendJson(res, 400, { success: false, error: `Directory not found: ${hostCwd}` });
      return;
    }
    const ghToken = getGitHubToken();
    const env = {};
    if (ghToken) { env.GITHUB_TOKEN = ghToken; env.GH_TOKEN = ghToken; }
    // Clear GPG_TTY so gpg-agent uses keychain/GUI pinentry (e.g. pinentry-mac)
    // instead of a stale terminal inherited from the shell that started the proxy.
    // GPG keys stay on the host — the container never sees them.
    env.GPG_TTY = '';
    const result = await executeCommand('git', body.args, { cwd: hostCwd, env });
    process.stderr.write(`[tool-proxy] git ${body.args.join(' ')} in ${hostCwd} -> exit ${result.exitCode}\n`);
    sendJson(res, 200, result);
    return;
  }

  // terraform handler (plan-only)
  if (req.url === '/terraform' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.args)) {
      sendJson(res, 400, { success: false, error: 'Invalid request: args required' });
      return;
    }
    const validation = validateTerraform(body.args);
    if (!validation.allowed) {
      process.stderr.write(`[tool-proxy] terraform ${body.args.join(' ')} BLOCKED (${validation.reason})\n`);
      sendJson(res, 200, { success: false, blocked: true, reason: validation.reason, stdout: '', stderr: validation.reason + '\n', exitCode: 126 });
      return;
    }
    const hostCwd = toHostPath(body.cwd);
    if (!hostCwd || !existsSync(hostCwd)) {
      sendJson(res, 400, { success: false, error: `Directory not found: ${hostCwd}` });
      return;
    }
    const translatedArgs = translateArgPaths(body.args);
    const result = await executeCommand('terraform', translatedArgs, { cwd: hostCwd });
    process.stderr.write(`[tool-proxy] terraform ${body.args.join(' ')} in ${hostCwd} -> exit ${result.exitCode}\n`);
    sendJson(res, 200, result);
    return;
  }

  // kubectl handler (read-only)
  if (req.url === '/kubectl' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.args)) {
      sendJson(res, 400, { success: false, error: 'Invalid request: args required' });
      return;
    }
    const validation = validateKubectl(body.args);
    if (!validation.allowed) {
      process.stderr.write(`[tool-proxy] kubectl ${body.args.join(' ')} BLOCKED (${validation.reason})\n`);
      sendJson(res, 200, { success: false, blocked: true, reason: validation.reason, stdout: '', stderr: validation.reason + '\n', exitCode: 126 });
      return;
    }
    const options = {};
    const hostCwd = toHostPath(body.cwd);
    if (hostCwd && existsSync(hostCwd)) options.cwd = hostCwd;
    const result = await executeCommand('kubectl', body.args, options);
    process.stderr.write(`[tool-proxy] kubectl ${body.args.join(' ')} -> exit ${result.exitCode}\n`);
    sendJson(res, 200, result);
    return;
  }

  // aws handler (read-only)
  if (req.url === '/aws' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.args)) {
      sendJson(res, 400, { success: false, error: 'Invalid request: args required' });
      return;
    }
    const validation = validateAws(body.args);
    if (!validation.allowed) {
      process.stderr.write(`[tool-proxy] aws ${body.args.join(' ')} BLOCKED (${validation.reason})\n`);
      sendJson(res, 200, { success: false, blocked: true, reason: validation.reason, stdout: '', stderr: validation.reason + '\n', exitCode: 126 });
      return;
    }
    const options = {};
    const hostCwd = toHostPath(body.cwd);
    if (hostCwd && existsSync(hostCwd)) options.cwd = hostCwd;
    const result = await executeCommand('aws', body.args, options);
    process.stderr.write(`[tool-proxy] aws ${body.args.join(' ')} -> exit ${result.exitCode}\n`);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { success: false, error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[tool-proxy] Listening on 127.0.0.1:${PORT} (workspace: ${HOST_WORKSPACE})\n`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
