#!/usr/bin/env node
// Moat tool proxy — runs on the host, executes commands with host credentials
// Container wrapper scripts proxy gh/git/terraform/kubectl/aws through this server
// Container wrapper scripts send container paths; proxy translates to host paths
// IaC tools (terraform/kubectl/aws) are restricted to read-only operations via allowlists

import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, unlinkSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForSecrets, isBlockingMode } from './lib/secrets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.TOOL_PROXY_PORT || '9876');
const TOKEN_PATH = process.env.MOAT_TOKEN_FILE || join(__dirname, '.proxy-token');
const TOKEN = readFileSync(TOKEN_PATH, 'utf-8').trim();

// Parse --data-dir argument (path to ~/.moat/data)
const dataDirIdx = process.argv.indexOf('--data-dir');
const DATA_DIR = dataDirIdx !== -1 ? process.argv[dataDirIdx + 1] : null;
if (!DATA_DIR) {
  process.stderr.write('Usage: tool-proxy.mjs --data-dir /path/to/moat/data\n');
  process.exit(1);
}

const WORKSPACES_DIR = join(DATA_DIR, 'workspaces');
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

// Multi-workspace path mappings: { hash: { "/workspace": hostPath, ... } }
let workspaceMappings = {};

function loadAllPathMappings() {
  const newMappings = {};
  try {
    if (!existsSync(WORKSPACES_DIR)) return;
    const entries = readdirSync(WORKSPACES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const mapFile = join(WORKSPACES_DIR, entry.name, 'path-mappings.json');
      try {
        if (existsSync(mapFile)) {
          newMappings[entry.name] = JSON.parse(readFileSync(mapFile, 'utf-8'));
        }
      } catch {}
    }
  } catch {}
  workspaceMappings = newMappings;
}

// Load once at startup
loadAllPathMappings();

// Get the path mappings for a specific workspace hash
function getMappingsForHash(workspaceHash) {
  // Reload mappings on every request (picks up new sessions + attach changes)
  loadAllPathMappings();

  if (workspaceHash && workspaceMappings[workspaceHash]) {
    return workspaceMappings[workspaceHash];
  }

  // Only fall back to single-session lookup when no hash was provided at all
  // (backward compat with old containers that predate workspace_hash).
  // Never fall back when a hash IS provided but not found — that means the
  // session's path-mappings.json was cleaned up and returning a different
  // session's mapping would route commands to the wrong repository.
  if (!workspaceHash) {
    const hashes = Object.keys(workspaceMappings);
    if (hashes.length === 1) {
      return workspaceMappings[hashes[0]];
    }
  }

  return {};
}

// Translate container path to host path.
// Returns null when no mapping is found (stale session or missing hash).
function toHostPath(containerPath, workspaceHash) {
  if (!containerPath) return null;

  const mappings = getMappingsForHash(workspaceHash);

  // No mappings found — session may have been cleaned up
  if (Object.keys(mappings).length === 0) return null;

  // Check exact matches first
  if (mappings[containerPath]) return mappings[containerPath];

  // Check prefix matches (e.g. /workspace/src/foo -> HOST_WORKSPACE/src/foo)
  for (const [prefix, hostBase] of Object.entries(mappings)) {
    if (containerPath.startsWith(prefix + '/')) {
      return join(hostBase, containerPath.slice(prefix.length + 1));
    }
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

// AWS: allowlist of read-only verb prefixes (safer than a blocklist)
const AWS_ALLOWED_VERBS = new Set([
  'describe', 'list', 'get', 'lookup', 'search', 'check', 'detect',
  'estimate', 'forecast', 'preview', 'query', 'scan', 'select',
  'test', 'validate', 'verify', 'batch-get', 'batch-describe',
]);

// AWS actions that are safe despite not matching allowed verb prefixes
const AWS_ALLOWED_ACTIONS = new Set([
  'sts get-caller-identity',
  'sts get-session-token',
  'sts get-access-key-info',
  's3 ls',
  's3 cp',               // read direction determined by args, but commonly needed
  's3api head-object',
  's3api head-bucket',
  'iam generate-credential-report',
  'ec2 wait',
  'cloudwatch wait',
  'logs tail',
  'logs filter-log-events',
  'logs start-query',     // starts an async query (read-only)
  'logs stop-query',
  'logs get-query-results',
  'cloudformation detect-stack-drift',
  'cloudformation detect-stack-resource-drift',
]);

function validateAws(args) {
  if (args.length === 0) return { allowed: true };
  // Find the subcommand (skip flags like --region, --profile)
  const nonFlagArgs = args.filter(a => !a.startsWith('-'));
  if (nonFlagArgs.length < 2) return { allowed: true }; // just service name or help
  const service = nonFlagArgs[0];
  const action = nonFlagArgs[1];
  // Check explicit service+action allowlist first
  if (AWS_ALLOWED_ACTIONS.has(`${service} ${action}`)) {
    return { allowed: true };
  }
  // Check verb prefix against allowed read-only verbs
  const verb = action.split('-')[0];
  if (AWS_ALLOWED_VERBS.has(verb)) {
    return { allowed: true };
  }
  return { allowed: false, reason: `aws ${service} ${action} is blocked by Moat (read-only mode)` };
}

// Check if a path is a known container mount point
function isContainerPath(p, workspaceHash) {
  const mappings = getMappingsForHash(workspaceHash);
  return Object.keys(mappings).some(prefix => p === prefix || p.startsWith(prefix + '/'));
}

// Translate file path arguments from container paths to host paths
function translateArgPaths(args, workspaceHash) {
  return args.map(arg => {
    if (isContainerPath(arg, workspaceHash)) {
      return toHostPath(arg, workspaceHash);
    }
    // Handle -var-file=/workspace/... style flags
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      const val = arg.slice(eqIdx + 1);
      if (isContainerPath(val, workspaceHash)) {
        return arg.slice(0, eqIdx + 1) + toHostPath(val, workspaceHash);
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
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Body too large')); return; }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { resolve(Buffer.concat(chunks)); });
  });
}

// Load MCP server config from DATA_DIR/mcp-servers.json (hot-reload on each request)
function loadMcpServers() {
  const configPath = join(DATA_DIR, 'mcp-servers.json');
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch {}
  return {};
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// --- Audit logging helper ---

function auditEmit(wsHash, type, payload = {}) {
  if (!wsHash) return;
  try {
    const auditPath = join(WORKSPACES_DIR, wsHash, 'audit.jsonl');
    const event = { ts: new Date().toISOString(), type, ...payload };
    appendFileSync(auditPath, JSON.stringify(event) + '\n');
  } catch {
    // Non-fatal — never let audit logging break request handling
  }
}

// --- Secrets scanning helpers ---

/**
 * Scan command args for secrets before execution.
 * Returns true if the request was blocked (response already sent).
 */
function secretsPreScan(endpoint, args, wsHash, res) {
  const text = args.join(' ');
  const hits = scanForSecrets(text);
  if (hits.length === 0) return false;

  for (const hit of hits) {
    process.stderr.write(`[secrets-scan] PRE ${endpoint}: ${hit.pattern} detected in args (line ${hit.line})\n`);
    auditEmit(wsHash, 'secrets.detected', { endpoint, pattern: hit.pattern, scan_phase: 'pre', action: isBlockingMode() ? 'blocked' : 'warned' });
  }

  if (isBlockingMode()) {
    const reason = `Potential secret detected in command args (${hits.map(h => h.pattern).join(', ')})`;
    sendJson(res, 200, { success: false, blocked: true, reason, stdout: '', stderr: reason + '\n', exitCode: 126 });
    return true;
  }

  return false;
}

/**
 * Scan command output for secrets after execution.
 * Returns true if the response was blocked (response already sent).
 */
function secretsPostScan(endpoint, result, wsHash, res) {
  const text = (result.stdout || '') + '\n' + (result.stderr || '');
  const hits = scanForSecrets(text);
  if (hits.length === 0) return false;

  for (const hit of hits) {
    process.stderr.write(`[secrets-scan] POST ${endpoint}: ${hit.pattern} detected in output (line ${hit.line})\n`);
    auditEmit(wsHash, 'secrets.detected', { endpoint, pattern: hit.pattern, scan_phase: 'post', action: isBlockingMode() ? 'blocked' : 'warned' });
  }

  if (isBlockingMode()) {
    const reason = `Potential secret detected in command output (${hits.map(h => h.pattern).join(', ')})`;
    sendJson(res, 200, { success: false, blocked: true, reason, stdout: '', stderr: reason + '\n', exitCode: 126 });
    return true;
  }

  return false;
}

// --- Agent management helpers ---

function generateAgentId() {
  return randomBytes(4).toString('hex');
}

function resolveAgentId(wsHash, partial) {
  const agentsDir = join(WORKSPACES_DIR, wsHash, 'agents');
  if (!existsSync(agentsDir)) return { error: 'No agents found.' };

  let entries;
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return { error: 'No agents found.' };
  }

  // Match by ID prefix first (Docker-style)
  const idMatches = entries
    .filter(e => e.isDirectory() && e.name.startsWith(partial))
    .map(e => e.name);

  if (idMatches.length === 1) return { id: idMatches[0] };
  if (idMatches.length > 1) return { error: `Ambiguous ID '${partial}' — matches: ${idMatches.join(', ')}` };

  // Fall back to name matching (exact or prefix)
  const nameMatches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = getAgentMeta(wsHash, entry.name);
    if (!meta) continue;
    if (meta.name === partial || meta.name.startsWith(partial)) {
      nameMatches.push(entry.name);
    }
  }

  if (nameMatches.length === 1) return { id: nameMatches[0] };
  if (nameMatches.length > 1) {
    const names = nameMatches.map(id => {
      const m = getAgentMeta(wsHash, id);
      return `${m?.name || id} (${id})`;
    });
    return { error: `Ambiguous name '${partial}' — matches: ${names.join(', ')}` };
  }

  return { error: `No agent matching '${partial}'.` };
}

function getAgentMeta(wsHash, agentId) {
  const metaPath = join(WORKSPACES_DIR, wsHash, 'agents', agentId, 'meta.json');
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveAgentMeta(wsHash, agentId, meta) {
  const dir = join(WORKSPACES_DIR, wsHash, 'agents', agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

async function getAgentContainerStatus(agentId) {
  const containerName = `moat-agent-${agentId}`;
  const result = await executeCommand('docker', [
    'inspect', containerName,
    '--format', '{{.State.Status}}:{{.State.ExitCode}}'
  ]);
  if (!result.success) return { exists: false };
  const parts = result.stdout.trim().split(':');
  return { exists: true, status: parts[0], exitCode: parseInt(parts[1], 10) };
}

async function getAgentLogs(agentId) {
  const containerName = `moat-agent-${agentId}`;
  const result = await executeCommand('docker', ['logs', containerName]);
  return result.success ? result.stdout : result.stderr;
}

function listAgentIds(wsHash) {
  const agentsDir = join(WORKSPACES_DIR, wsHash, 'agents');
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

function removeAgentMeta(wsHash, agentId) {
  const dir = join(WORKSPACES_DIR, wsHash, 'agents', agentId);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
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

  // Reject oversized requests early via content-length header
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_BODY_SIZE) {
    sendJson(res, 413, { success: false, error: 'Request body too large' });
    return;
  }

  // gh handler
  if (req.url === '/gh' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.args)) {
      sendJson(res, 400, { success: false, error: 'Invalid request: args required' });
      return;
    }
    const wsHash = body.workspace_hash || '';
    const ghToken = getGitHubToken();
    const env = {};
    if (ghToken) { env.GITHUB_TOKEN = ghToken; env.GH_TOKEN = ghToken; }
    const options = { env };
    const hostCwd = toHostPath(body.cwd, wsHash);
    if (hostCwd && existsSync(hostCwd)) {
      options.cwd = hostCwd;
    } else if (body.cwd && !hostCwd) {
      const msg = `No path mapping for workspace hash '${wsHash}' — session may have ended. Restart moat to fix.`;
      process.stderr.write(`[tool-proxy] gh REJECTED: ${msg}\n`);
      sendJson(res, 400, { success: false, error: msg });
      return;
    }
    if (secretsPreScan('gh', body.args, wsHash, res)) return;
    const startTime = Date.now();
    const result = await executeCommand('gh', body.args, options);
    const duration_ms = Date.now() - startTime;
    process.stderr.write(`[tool-proxy] gh ${body.args.join(' ')} -> exit ${result.exitCode}\n`);
    auditEmit(wsHash, 'tool.execute', { endpoint: 'gh', args_summary: body.args.join(' '), exit_code: result.exitCode, duration_ms });
    if (secretsPostScan('gh', result, wsHash, res)) return;
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
    const wsHash = body.workspace_hash || '';
    const hostCwd = toHostPath(body.cwd, wsHash);
    if (!hostCwd) {
      const msg = `No path mapping for workspace hash '${wsHash}' — session may have ended. Restart moat to fix.`;
      process.stderr.write(`[tool-proxy] git REJECTED: ${msg}\n`);
      sendJson(res, 400, { success: false, error: msg });
      return;
    }
    if (!existsSync(hostCwd)) {
      sendJson(res, 400, { success: false, error: `Directory not found: ${hostCwd}` });
      return;
    }
    const ghToken = getGitHubToken();
    const env = {};
    if (ghToken) { env.GITHUB_TOKEN = ghToken; env.GH_TOKEN = ghToken; }
    if (secretsPreScan('git', body.args, wsHash, res)) return;
    const startTime = Date.now();
    const result = await executeCommand('git', body.args, { cwd: hostCwd, env });
    const duration_ms = Date.now() - startTime;
    process.stderr.write(`[tool-proxy] git ${body.args.join(' ')} in ${hostCwd} -> exit ${result.exitCode}\n`);
    auditEmit(wsHash, 'tool.execute', { endpoint: 'git', args_summary: body.args.join(' '), exit_code: result.exitCode, duration_ms });
    if (secretsPostScan('git', result, wsHash, res)) return;
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
    const wsHash = body.workspace_hash || '';
    if (!validation.allowed) {
      process.stderr.write(`[tool-proxy] terraform ${body.args.join(' ')} BLOCKED (${validation.reason})\n`);
      auditEmit(wsHash, 'tool.blocked', { endpoint: 'terraform', args_summary: body.args.join(' '), reason: validation.reason });
      sendJson(res, 200, { success: false, blocked: true, reason: validation.reason, stdout: '', stderr: validation.reason + '\n', exitCode: 126 });
      return;
    }
    const hostCwd = toHostPath(body.cwd, wsHash);
    if (!hostCwd || !existsSync(hostCwd)) {
      sendJson(res, 400, { success: false, error: `Directory not found: ${hostCwd}` });
      return;
    }
    const translatedArgs = translateArgPaths(body.args, wsHash);
    if (secretsPreScan('terraform', body.args, wsHash, res)) return;
    const startTime = Date.now();
    const result = await executeCommand('terraform', translatedArgs, { cwd: hostCwd });
    const duration_ms = Date.now() - startTime;
    process.stderr.write(`[tool-proxy] terraform ${body.args.join(' ')} in ${hostCwd} -> exit ${result.exitCode}\n`);
    auditEmit(wsHash, 'tool.execute', { endpoint: 'terraform', args_summary: body.args.join(' '), exit_code: result.exitCode, duration_ms });
    if (secretsPostScan('terraform', result, wsHash, res)) return;
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
    const wsHash = body.workspace_hash || '';
    if (!validation.allowed) {
      process.stderr.write(`[tool-proxy] kubectl ${body.args.join(' ')} BLOCKED (${validation.reason})\n`);
      auditEmit(wsHash, 'tool.blocked', { endpoint: 'kubectl', args_summary: body.args.join(' '), reason: validation.reason });
      sendJson(res, 200, { success: false, blocked: true, reason: validation.reason, stdout: '', stderr: validation.reason + '\n', exitCode: 126 });
      return;
    }
    const options = {};
    const hostCwd = toHostPath(body.cwd, wsHash);
    if (hostCwd && existsSync(hostCwd)) {
      options.cwd = hostCwd;
    } else if (body.cwd && !hostCwd) {
      const msg = `No path mapping for workspace hash '${wsHash}' — session may have ended. Restart moat to fix.`;
      process.stderr.write(`[tool-proxy] kubectl REJECTED: ${msg}\n`);
      sendJson(res, 400, { success: false, error: msg });
      return;
    }
    if (secretsPreScan('kubectl', body.args, wsHash, res)) return;
    const startTime = Date.now();
    const result = await executeCommand('kubectl', body.args, options);
    const duration_ms = Date.now() - startTime;
    process.stderr.write(`[tool-proxy] kubectl ${body.args.join(' ')} -> exit ${result.exitCode}\n`);
    auditEmit(wsHash, 'tool.execute', { endpoint: 'kubectl', args_summary: body.args.join(' '), exit_code: result.exitCode, duration_ms });
    if (secretsPostScan('kubectl', result, wsHash, res)) return;
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
    const wsHash = body.workspace_hash || '';
    if (!validation.allowed) {
      process.stderr.write(`[tool-proxy] aws ${body.args.join(' ')} BLOCKED (${validation.reason})\n`);
      auditEmit(wsHash, 'tool.blocked', { endpoint: 'aws', args_summary: body.args.join(' '), reason: validation.reason });
      sendJson(res, 200, { success: false, blocked: true, reason: validation.reason, stdout: '', stderr: validation.reason + '\n', exitCode: 126 });
      return;
    }
    const options = {};
    const hostCwd = toHostPath(body.cwd, wsHash);
    if (hostCwd && existsSync(hostCwd)) {
      options.cwd = hostCwd;
    } else if (body.cwd && !hostCwd) {
      const msg = `No path mapping for workspace hash '${wsHash}' — session may have ended. Restart moat to fix.`;
      process.stderr.write(`[tool-proxy] aws REJECTED: ${msg}\n`);
      sendJson(res, 400, { success: false, error: msg });
      return;
    }
    if (secretsPreScan('aws', body.args, wsHash, res)) return;
    const startTime = Date.now();
    const result = await executeCommand('aws', body.args, options);
    const duration_ms = Date.now() - startTime;
    process.stderr.write(`[tool-proxy] aws ${body.args.join(' ')} -> exit ${result.exitCode}\n`);
    auditEmit(wsHash, 'tool.execute', { endpoint: 'aws', args_summary: body.args.join(' '), exit_code: result.exitCode, duration_ms });
    if (secretsPostScan('aws', result, wsHash, res)) return;
    sendJson(res, 200, result);
    return;
  }

  // MCP reverse proxy handler — forward to upstream MCP servers with auth injection
  const mcpMatch = req.url.match(/^\/mcp\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  if (mcpMatch) {
    const serverName = mcpMatch[1];
    const mcpServers = loadMcpServers();
    const serverConfig = mcpServers[serverName];

    if (!serverConfig || !serverConfig.url) {
      sendJson(res, 404, { success: false, error: `MCP server not found: ${serverName}` });
      return;
    }

    try {
      const body = await readRawBody(req);

      // Build upstream URL — append any sub-path after /mcp/<name>
      const subPath = mcpMatch[2] || '';
      const upstreamUrl = serverConfig.url + subPath;

      // Build upstream headers — start with content-type, inject auth from config
      const upstreamHeaders = {};
      if (req.headers['content-type']) {
        upstreamHeaders['content-type'] = req.headers['content-type'];
      }
      if (req.headers['accept']) {
        upstreamHeaders['accept'] = req.headers['accept'];
      }
      // Forward Mcp-Session-Id bidirectionally (required by MCP Streamable HTTP spec)
      if (req.headers['mcp-session-id']) {
        upstreamHeaders['mcp-session-id'] = req.headers['mcp-session-id'];
      }

      // Inject auth headers from server config (these never enter the container)
      if (serverConfig.headers) {
        for (const [key, value] of Object.entries(serverConfig.headers)) {
          upstreamHeaders[key] = value;
        }
      }

      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body: body.length > 0 ? body : undefined,
      });

      // Forward response status and key headers
      const responseHeaders = {};
      const contentType = upstreamRes.headers.get('content-type');
      if (contentType) responseHeaders['content-type'] = contentType;
      const sessionId = upstreamRes.headers.get('mcp-session-id');
      if (sessionId) responseHeaders['mcp-session-id'] = sessionId;

      res.writeHead(upstreamRes.status, responseHeaders);

      // Stream the response body back (supports both buffered JSON and SSE)
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        pump().catch(() => res.end());
      } else {
        res.end();
      }

      process.stderr.write(`[tool-proxy] mcp/${serverName} ${req.method} -> ${upstreamRes.status}\n`);
    } catch (e) {
      process.stderr.write(`[tool-proxy] mcp/${serverName} ERROR: ${e.message}\n`);
      sendJson(res, 502, { success: false, error: `MCP proxy error: ${e.message}` });
    }
    return;
  }

  // --- Agent management endpoints ---
  if (req.url.startsWith('/agent/')) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const agentPath = parsedUrl.pathname;
    const wsHashParam = parsedUrl.searchParams.get('workspace_hash') || '';

    // POST /agent/spawn
    if (agentPath === '/agent/spawn' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.prompt) {
        sendJson(res, 400, { success: false, error: 'prompt required' });
        return;
      }
      const wsHash = body.workspace_hash;
      if (!wsHash) {
        sendJson(res, 400, { success: false, error: 'workspace_hash required' });
        return;
      }

      const apiKeyEnv = body.api_key_env || 'ANTHROPIC_API_KEY';
      const apiKey = process.env[apiKeyEnv] || '';
      if (!apiKey) {
        sendJson(res, 400, { success: false, error: `${apiKeyEnv} not set on host — cannot spawn agent.` });
        return;
      }

      const mappings = getMappingsForHash(wsHash);
      const hostWorkspace = mappings['/workspace'];
      if (!hostWorkspace) {
        sendJson(res, 400, { success: false, error: 'No workspace mapping found — session may have ended.' });
        return;
      }

      const id = generateAgentId();
      const name = body.name || `agent-${id.slice(0, 4)}`;
      const network = `moat-${wsHash}_sandbox`;
      const tools = body.tools || 'Read,Grep,Glob,Task,WebFetch,WebSearch';

      const runtimeName = body.runtime || 'claude';
      const runtimeBinary = body.runtime_binary || 'claude';
      const agentImageName = `moat-agent-${runtimeName}`;

      // Write API key to a temp env file (avoids exposing it in docker inspect / /proc)
      const envFile = join(tmpdir(), `moat-agent-${id}.env`);
      writeFileSync(envFile, `${apiKeyEnv}=${apiKey}\n`, { mode: 0o600 });

      const dockerArgs = [
        'run', '--detach',
        '--name', `moat-agent-${id}`,
        '--network', network,
        '--label', 'moat.agent=true',
        '--label', `moat.agent.id=${id}`,
        '--label', `moat.workspace_hash=${wsHash}`,
        '--memory', '4g', '--cpus', '2',
        '--add-host', 'host.docker.internal:host-gateway',
        '--env-file', envFile,
        '--env', `HTTP_PROXY=http://squid:3128`,
        '--env', `HTTPS_PROXY=http://squid:3128`,
        '--env', `http_proxy=http://squid:3128`,
        '--env', `https_proxy=http://squid:3128`,
        '--env', `NO_PROXY=localhost,127.0.0.1`,
        '--env', `no_proxy=localhost,127.0.0.1`,
        '--env', `MOAT_WORKSPACE_HASH=${wsHash}`,
        '--env', `MOAT_AGENT_PROMPT=${body.prompt}`,
        '--env', `MOAT_AGENT_TOOLS=${tools}`,
        '--env', `MOAT_RUNTIME_BINARY=${runtimeBinary}`,
        '--mount', `type=bind,src=${hostWorkspace},dst=/workspace,readonly`,
        agentImageName,
      ];

      const result = await executeCommand('docker', dockerArgs);
      // Clean up temp env file immediately after docker reads it
      try { unlinkSync(envFile); } catch {}
      if (!result.success) {
        process.stderr.write(`[tool-proxy] agent/spawn FAILED: ${result.stderr}\n`);
        sendJson(res, 500, { success: false, error: result.stderr.trim() });
        return;
      }

      const meta = {
        id,
        name,
        prompt: body.prompt,
        status: 'running',
        started_at: new Date().toISOString(),
      };
      saveAgentMeta(wsHash, id, meta);

      process.stderr.write(`[tool-proxy] agent/spawn ${id} (${name})\n`);
      auditEmit(wsHash, 'agent.spawn', { agent_id: id, name, prompt_truncated: body.prompt.slice(0, 200) });
      sendJson(res, 200, { success: true, id, name });
      return;
    }

    // GET /agent/list
    if (agentPath === '/agent/list' && req.method === 'GET') {
      if (!wsHashParam) {
        sendJson(res, 400, { success: false, error: 'workspace_hash required' });
        return;
      }

      const agentIds = listAgentIds(wsHashParam);
      const agents = [];

      for (const agentId of agentIds) {
        const meta = getAgentMeta(wsHashParam, agentId);
        if (!meta) continue;

        // Reconcile status with Docker
        if (meta.status === 'running') {
          const container = await getAgentContainerStatus(agentId);
          if (!container.exists || container.status === 'exited') {
            meta.status = (container.exitCode === 0) ? 'done' : 'failed';
            meta.exit_code = container.exitCode;
            saveAgentMeta(wsHashParam, agentId, meta);
            auditEmit(wsHashParam, 'agent.done', { agent_id: agentId, status: meta.status, exit_code: container.exitCode });
          }
        }

        agents.push(meta);
      }

      sendJson(res, 200, { success: true, agents });
      return;
    }

    // GET /agent/log/<id>
    const logMatch = agentPath.match(/^\/agent\/log\/(.+)$/);
    if (logMatch && req.method === 'GET') {
      if (!wsHashParam) {
        sendJson(res, 400, { success: false, error: 'workspace_hash required' });
        return;
      }

      const resolved = resolveAgentId(wsHashParam, logMatch[1]);
      if (resolved.error) {
        sendJson(res, 404, { success: false, error: resolved.error });
        return;
      }

      const log = await getAgentLogs(resolved.id);
      sendJson(res, 200, { success: true, log });
      return;
    }

    // POST /agent/kill/<id>
    const killMatch = agentPath.match(/^\/agent\/kill\/(.+)$/);
    if (killMatch && req.method === 'POST') {
      const body = await readBody(req);
      const wsHash = body?.workspace_hash;
      if (!wsHash) {
        sendJson(res, 400, { success: false, error: 'workspace_hash required' });
        return;
      }

      const target = killMatch[1];

      if (target === '--all') {
        const agentIds = listAgentIds(wsHash);
        let killed = 0;
        for (const agentId of agentIds) {
          const meta = getAgentMeta(wsHash, agentId);
          if (!meta || meta.status !== 'running') continue;
          const containerName = `moat-agent-${agentId}`;
          await executeCommand('docker', ['rm', '-f', containerName]);
          meta.status = 'killed';
          saveAgentMeta(wsHash, agentId, meta);
          auditEmit(wsHash, 'agent.done', { agent_id: agentId, status: 'killed', exit_code: null });
          killed++;
        }
        process.stderr.write(`[tool-proxy] agent/kill --all (${killed} killed)\n`);
        sendJson(res, 200, { success: true, message: `Killed ${killed} agent(s).` });
        return;
      }

      const resolved = resolveAgentId(wsHash, target);
      if (resolved.error) {
        sendJson(res, 404, { success: false, error: resolved.error });
        return;
      }

      const containerName = `moat-agent-${resolved.id}`;
      await executeCommand('docker', ['rm', '-f', containerName]);
      const meta = getAgentMeta(wsHash, resolved.id);
      if (meta) {
        meta.status = 'killed';
        saveAgentMeta(wsHash, resolved.id, meta);
      }

      process.stderr.write(`[tool-proxy] agent/kill ${resolved.id}\n`);
      auditEmit(wsHash, 'agent.done', { agent_id: resolved.id, status: 'killed', exit_code: null });
      sendJson(res, 200, { success: true, message: `Killed ${resolved.id}.` });
      return;
    }

    // GET /agent/results
    if (agentPath === '/agent/results' && req.method === 'GET') {
      if (!wsHashParam) {
        sendJson(res, 400, { success: false, error: 'workspace_hash required' });
        return;
      }

      const agentIds = listAgentIds(wsHashParam);
      const results = [];

      for (const agentId of agentIds) {
        const meta = getAgentMeta(wsHashParam, agentId);
        if (!meta) continue;

        // Reconcile status
        if (meta.status === 'running') {
          const container = await getAgentContainerStatus(agentId);
          if (!container.exists || container.status === 'exited') {
            meta.status = (container.exitCode === 0) ? 'done' : 'failed';
            meta.exit_code = container.exitCode;
            auditEmit(wsHashParam, 'agent.done', { agent_id: agentId, status: meta.status, exit_code: container.exitCode });
          }
        }

        if (meta.status === 'done' || meta.status === 'failed') {
          const log = await getAgentLogs(agentId);
          results.push({ ...meta, log });

          // Clean up container and metadata
          await executeCommand('docker', ['rm', '-f', `moat-agent-${agentId}`]);
          removeAgentMeta(wsHashParam, agentId);
        }
      }

      process.stderr.write(`[tool-proxy] agent/results -> ${results.length} completed\n`);
      sendJson(res, 200, { success: true, results });
      return;
    }

    // GET /agent/wait/<id>
    const waitMatch = agentPath.match(/^\/agent\/wait\/(.+)$/);
    if (waitMatch && req.method === 'GET') {
      if (!wsHashParam) {
        sendJson(res, 400, { success: false, error: 'workspace_hash required' });
        return;
      }

      const resolved = resolveAgentId(wsHashParam, waitMatch[1]);
      if (resolved.error) {
        sendJson(res, 404, { success: false, error: resolved.error });
        return;
      }

      // Poll until container exits (timeout 5 min)
      const timeout = 300000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const container = await getAgentContainerStatus(resolved.id);
        if (!container.exists) {
          sendJson(res, 200, { success: true, status: 'not_found', log: '' });
          return;
        }
        if (container.status === 'exited') {
          const log = await getAgentLogs(resolved.id);
          const meta = getAgentMeta(wsHashParam, resolved.id);
          const status = (container.exitCode === 0) ? 'done' : 'failed';
          if (meta) {
            meta.status = status;
            meta.exit_code = container.exitCode;
            saveAgentMeta(wsHashParam, resolved.id, meta);
          }
          auditEmit(wsHashParam, 'agent.done', { agent_id: resolved.id, status, exit_code: container.exitCode });
          process.stderr.write(`[tool-proxy] agent/wait ${resolved.id} -> ${status}\n`);
          sendJson(res, 200, { success: true, status, exit_code: container.exitCode, log });
          return;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      sendJson(res, 200, { success: false, error: 'Timeout waiting for agent.' });
      return;
    }

    sendJson(res, 404, { success: false, error: 'Unknown agent endpoint' });
    return;
  }

  sendJson(res, 404, { success: false, error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[tool-proxy] Listening on 127.0.0.1:${PORT} (data-dir: ${DATA_DIR})\n`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
