# Per-Session Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `moat` invocation gets its own container (random 4-hex session suffix, or a stable `--name` label), so concurrent sessions on the same workspace no longer share one container or its resource limits.

**Architecture:** A session is identified by `<wsHash8>-<suffix>` (e.g. `a1b2c3d4-a3f2`). This full session ID becomes the per-session data dir name under `~/.moat/data/workspaces/`, the compose project name (`moat-<sessionId>`), the config volume name (`moat-config-<sessionId>`), and the `MOAT_WORKSPACE_HASH` container env. Because the tool-proxy already keys path mappings, audit logs, and agent management off the directory name / `MOAT_WORKSPACE_HASH`, the proxy needs **zero changes** — everything becomes per-session automatically. Containers are discovered by compose-project label instead of workspace label.

**Tech Stack:** Node ESM (`.mjs`), `node:test` for unit tests (new `test/` dir, no package.json needed), docker compose project isolation.

**Key invariants (revised per user feedback mid-execution):**
- No `--name` → if sessions are already running for the workspace and stdin is a TTY, show a picker: select a session to reattach, or start a new one. Otherwise (no sessions / non-TTY / dispatch) → fresh random suffix → new container.
- `--name session1` → suffix is the sanitized label → reuse if a container with project `moat-<hash>-session1` is running; skip the picker.
- `moat attach --name session1` → same as above but errors if no such container is running.
- Legacy containers (project `moat-<hash8>`, no suffix) are still discoverable by `ps`/`down` and torn down correctly via project label.
- The config volume stays **per-workspace** (`moat-config-<hash8>`), shared by all of that workspace's sessions — deviation from spec req 2, because per-session volumes would break the documented `moat --resume` / `--continue` flow (docs/usage.md) and leak volumes. Concurrent mounts are safe (the global bashhistory volume already does this); conversation files are per-session UUIDs.

---

### Task 0: Branch + commit the pending resource-limit bump

**Files:**
- Modify: `docker-compose.yml` (already modified in working tree: 4→8 CPUs, 8G→16G)

- [ ] **Step 1: Create branch**

```bash
git checkout -b feature/per-session-containers
```

- [ ] **Step 2: Commit the dirty docker-compose.yml** (it implements req 7's "currently 8CPU/16GB" baseline; limits are per compose project, so once projects are unique each container gets its own 8CPU/16GB)

```bash
git add docker-compose.yml
git commit -m "feat: bump devcontainer resource limits to 8 CPUs / 16G per container"
```

---

### Task 1: Session ID primitives in `lib/workspace-id.mjs`

**Files:**
- Modify: `lib/workspace-id.mjs`
- Create: `test/workspace-id.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
// test/workspace-id.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceId, sessionId, randomSessionSuffix, sanitizeSessionName } from '../lib/workspace-id.mjs';

test('workspaceId returns stable 8-char hex hash', () => {
  const a = workspaceId('/Users/x/repo');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, workspaceId('/Users/x/repo'));
  assert.notEqual(a, workspaceId('/Users/x/other'));
});

test('randomSessionSuffix returns 4 hex chars and varies', () => {
  const s = randomSessionSuffix();
  assert.match(s, /^[0-9a-f]{4}$/);
  const seen = new Set(Array.from({ length: 20 }, () => randomSessionSuffix()));
  assert.ok(seen.size > 1);
});

test('sessionId appends suffix to workspace hash', () => {
  const id = sessionId('/Users/x/repo', 'a3f2');
  assert.equal(id, `${workspaceId('/Users/x/repo')}-a3f2`);
});

test('sanitizeSessionName lowercases and accepts simple labels', () => {
  assert.equal(sanitizeSessionName('Session1'), 'session1');
  assert.equal(sanitizeSessionName('my-session'), 'my-session');
});

test('sanitizeSessionName strips unsafe chars', () => {
  assert.equal(sanitizeSessionName('my session!'), 'my-session');
});

test('sanitizeSessionName throws on empty/invalid labels', () => {
  assert.throws(() => sanitizeSessionName('!!!'));
  assert.throws(() => sanitizeSessionName(''));
  assert.throws(() => sanitizeSessionName('---'));
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/workspace-id.test.mjs`
Expected: FAIL — `sessionId` etc. not exported.

- [ ] **Step 3: Implement**

Append to `lib/workspace-id.mjs` (add `randomBytes` to the existing crypto import):

```js
import { createHash, randomBytes } from 'node:crypto';

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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/workspace-id.test.mjs`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add lib/workspace-id.mjs test/workspace-id.test.mjs
git commit -m "feat: add session ID primitives to workspace-id"
```

---

### Task 2: CLI parsing — `--name` flag and `attach` subcommand

**Files:**
- Modify: `lib/cli.mjs`
- Create: `test/cli.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
// test/cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/cli.mjs';

const argv = (...rest) => ['node', 'moat.mjs', ...rest];

test('parseArgs extracts --name in main flow', () => {
  const p = parseArgs(argv('--name', 'session1'));
  assert.equal(p.sessionName, 'session1');
  assert.deepEqual(p.claudeArgs, []);
});

test('parseArgs --name with workspace and claude args', () => {
  const p = parseArgs(argv('/tmp', '--name', 'dev1', '--resume'));
  assert.equal(p.workspace, '/tmp');
  assert.equal(p.sessionName, 'dev1');
  assert.deepEqual(p.claudeArgs, ['--resume']);
});

test('parseArgs --name without value throws', () => {
  assert.throws(() => parseArgs(argv('--name')));
});

test('parseArgs no --name leaves sessionName null', () => {
  const p = parseArgs(argv());
  assert.equal(p.sessionName, null);
});

test('parseArgs treats attach as raw subcommand', () => {
  const p = parseArgs(argv('attach', '--name', 'session1'));
  assert.equal(p.subcommand, 'attach');
  assert.deepEqual(p.subcommandArgs, ['--name', 'session1']);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — `sessionName` undefined, `attach` rejected as unknown command.

- [ ] **Step 3: Implement in `lib/cli.mjs`**

Add `'attach'` to `rawSubcommands`:

```js
  const rawSubcommands = new Set([
    'doctor', 'update', 'down', 'stop', 'attach-dir', 'detach-dir', 'uninstall', 'allow-domain',
    'ps', 'log', 'audit', 'rewind', 'help', 'dispatch', 'sync-skills', 'attach',
  ]);
```

In the flag loop, add `let sessionName = null;` next to `runtimeArg` and a branch:

```js
    } else if (rest[i] === '--name') {
      i++;
      if (i < rest.length && rest[i] && !rest[i].startsWith('-')) {
        sessionName = rest[i];
      } else {
        throw new Error('--name requires a session label');
      }
    }
```

Return it: `return { subcommand, subcommandArgs: [], workspace, extraDirs, claudeArgs, runtimeArg, mcpRw, sessionName };`

Also add `sessionName: null` to the early-return objects for raw subcommands and help so destructuring is uniform.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add lib/cli.mjs test/cli.test.mjs
git commit -m "feat: parse --name session label and attach subcommand"
```

---

### Task 3: Container helpers — session-scoped find/teardown in `lib/container.mjs`

**Files:**
- Modify: `lib/container.mjs`

- [ ] **Step 1: Export `getComposeProject` and add `findSessionContainer`**

Change `async function getComposeProject` to `export async function getComposeProject` (it stays otherwise identical).

Add:

```js
/**
 * Find the running devcontainer for a specific session by compose project label.
 * Returns the container name or null.
 */
export async function findSessionContainer(projectName) {
  try {
    const result = await runCapture('docker', [
      'ps',
      '--filter', `label=com.docker.compose.project=${projectName}`,
      '--filter', 'label=com.docker.compose.service=devcontainer',
      '--format', '{{.Names}}'
    ], { allowFailure: true });
    return result.stdout.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Replace `teardown(workspace)` with `teardownSession(containerName)`**

Delete the existing `teardown` function and add:

```js
/**
 * Tear down a single session's containers (devcontainer + squid + its agents).
 * Resolves the compose project from the container's labels.
 * The per-workspace config volume is left alone (shared across sessions,
 * keeps --continue/--resume history).
 */
export async function teardownSession(containerName) {
  const project = await getComposeProject(containerName);
  const sid = project && project.startsWith('moat-') ? project.slice('moat-'.length) : null;

  // Agent containers are labeled moat.workspace_hash=<sessionId>
  if (sid) await stopAgentContainers(sid);

  if (project) {
    await runCapture('docker', ['compose', '--project-name', project, 'down'], { allowFailure: true });
  } else {
    await runCapture('docker', ['rm', '-f', containerName], { allowFailure: true });
  }
}
```

The `workspaceId` import at the top of the file becomes unused — remove it.

- [ ] **Step 3: Extend `findMoatContainers` with project + session**

Replace the function body:

```js
/**
 * Find all running moat devcontainers.
 * Returns array of { name, workspace, project, session } objects.
 * session is the compose-project suffix after "moat-<hash8>-" ('' for legacy containers).
 */
export async function findMoatContainers() {
  try {
    const result = await runCapture('docker', [
      'ps', '--filter', 'label=devcontainer.local_folder',
      '--format', '{{.Names}}\t{{.Label "devcontainer.local_folder"}}\t{{.Label "com.docker.compose.project"}}'
    ], { allowFailure: true });
    return result.stdout.trim().split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, workspace, project] = line.split('\t');
        const m = (project || '').match(/^moat-[0-9a-f]{8}-(.+)$/);
        return { name, workspace, project: project || '', session: m ? m[1] : '' };
      })
      .filter(c => c.name.startsWith('moat-'));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Add session-dir helper**

```js
import { workspaceDataDir } from './workspace-id.mjs';

/**
 * Derive a running container's per-session data directory from its compose project.
 * Returns null if the project label is missing or not moat-managed.
 */
export async function sessionDirFromContainer(containerName) {
  const project = await getComposeProject(containerName);
  if (!project || !project.startsWith('moat-')) return null;
  return workspaceDataDir(project.slice('moat-'.length));
}
```

- [ ] **Step 5: Syntax check**

Run: `node --check lib/container.mjs && grep -rn "teardown(" lib moat.mjs | grep -v teardownSession`
Expected: syntax OK; the grep shows remaining `teardown(` callers in `lib/down.mjs`, `lib/attach.mjs`, `moat.mjs` — fixed in Tasks 4–6. (Don't commit a broken tree: Tasks 3–6 land as one commit at the end of Task 6 if intermediate states don't parse together; preferred order is implement Tasks 3–6 then commit each file group, but a single combined commit is acceptable. To keep commits green, do NOT delete `teardown` until Task 6 updates the last caller — alternatively keep both functions temporarily and delete `teardown` in Task 6.)

**Chosen approach to keep every commit green:** in this task, ADD the new functions but KEEP the old `teardown` export. Task 6 removes it after the last caller is migrated.

- [ ] **Step 6: Commit**

```bash
git add lib/container.mjs
git commit -m "feat: session-scoped container discovery and teardown"
```

---

### Task 4: Main flow — per-session ID, `--name`, `attach` in `moat.mjs`

**Files:**
- Modify: `moat.mjs`

- [ ] **Step 1: Update imports**

```js
import { findSessionContainer, findMoatContainers, mountsMatch, teardownSession, startContainer, execRuntime, isContainerRunning } from './lib/container.mjs';
import { workspaceId, workspaceDataDir, sessionId, randomSessionSuffix, sanitizeSessionName } from './lib/workspace-id.mjs';
```

Destructure `sessionName` from `parsed`:

```js
let { subcommand, subcommandArgs, workspace, extraDirs, claudeArgs, runtimeArg, mcpRw, sessionName } = parsed;
let attachMode = false;
```

- [ ] **Step 2: Handle `attach` subcommand** (insert after the `dispatch` block, before `// --- Main flow ---`):

```js
if (subcommand === 'attach') {
  // moat attach --name <label> [workspace] [claude args...]
  const { statSync: _statSync } = await import('node:fs');
  const { resolve: _resolve } = await import('node:path');
  const passthrough = [];
  for (let i = 0; i < subcommandArgs.length; i++) {
    const a = subcommandArgs[i];
    if (a === '--name') {
      i++;
      sessionName = subcommandArgs[i] || null;
    } else if (!a.startsWith('-') && existsSync(a) && _statSync(a).isDirectory()) {
      workspace = _resolve(a);
    } else {
      passthrough.push(a);
    }
  }
  if (!sessionName) {
    err('Usage: moat attach --name <label> [workspace]');
    process.exit(1);
  }
  claudeArgs = passthrough;
  attachMode = true;
  subcommand = null; // fall through to main flow
}
```

- [ ] **Step 3: Per-session identity** — replace the current block

```js
// Compute per-workspace data directory
const hash = workspaceId(workspace);
const wsDir = workspaceDataDir(hash);
mkdirSync(wsDir, { recursive: true });
const configVolume = `moat-config-${hash}`;
```

with:

```js
// Compute per-session identity: <wsHash8>-<suffix>
// The full session ID names the data dir, compose project, and config volume,
// and is passed to the tool-proxy as MOAT_WORKSPACE_HASH so path mappings,
// audit logs, and agents are all scoped per session.
const wsHash = workspaceId(workspace);
let sessionSuffix;
if (sessionName) {
  try {
    sessionSuffix = sanitizeSessionName(sessionName);
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
} else {
  // Random suffix; retry on the unlikely collision with a running session
  do {
    sessionSuffix = randomSessionSuffix();
  } while (await findSessionContainer(`moat-${wsHash}-${sessionSuffix}`));
}
const hash = sessionId(workspace, sessionSuffix);
const wsDir = workspaceDataDir(hash);
mkdirSync(wsDir, { recursive: true });
const configVolume = `moat-config-${wsHash}`; // per-workspace, shared across sessions (keeps --resume working)
```

**Session picker (user-requested UX):** before the identity block, when `!sessionName && !attachMode && !dispatchOpts && process.stdin.isTTY`, list running sessions for the workspace (`findMoatContainers()` filtered by `c.workspace === workspace && c.session`); if any, show an arrow-key picker (new `lib/select.mjs`, generic `selectFromList(items, { label, extraOption })`) offering each session plus "[ start a new session ]". Selecting a session sets `sessionName = choice.session; attachMode = true`; selecting new falls through to random suffix; cancel exits 0.

(Keeping the variable named `hash` means every downstream use — `MOAT_WORKSPACE_HASH`, devcontainer name, agent dirs, `runHeadlessDispatch(hash, ...)` — automatically becomes per-session.)

- [ ] **Step 4: Session info in audit + log line**

Update the session.start emit to include the session suffix and plain workspace hash:

```js
audit.emit('session.start', { workspace, hash, workspace_hash: wsHash, session: sessionSuffix, moat_version: moatVersion, runtime: runtimeName, head_sha: headSha });
```

After the identity block, print the session so users can reconnect:

```js
log(`Session ${DIM}${sessionSuffix}${RESET}${sessionName ? '' : ` (reconnect: moat --name <label> next time, or moat down to stop)`}`);
```

(Exact wording flexible; keep it one line.)

- [ ] **Step 5: Project name + start/reuse logic** — replace

```js
// Per-workspace compose project name — isolates concurrent sessions
const projectName = `moat-${hash}`;

// Start or reuse container
const existing = await findContainer(workspace);
if (existing) {
  ...
}
...
const containerName = await findContainer(workspace);
```

with:

```js
// Per-session compose project name — isolates concurrent sessions
const projectName = `moat-${hash}`;

// Start or reuse container (reuse only happens for named sessions / attach;
// unnamed sessions always get a fresh suffix, hence a fresh container)
const existing = await findSessionContainer(projectName);
if (attachMode && !existing) {
  err(`No running session named '${sessionSuffix}' for this workspace.`);
  err(`Start one with: moat ${workspace} --name ${sessionSuffix}`);
  process.exit(1);
}
if (existing) {
  if (await mountsMatch(extraDirs, existing, configVolume)) {
    log('Reusing running container');
  } else {
    log('Container config changed — recreating container...');
    await teardownSession(existing);
    await startContainer(workspace, REPO_DIR, wsDir, projectName);
  }
} else {
  await startContainer(workspace, REPO_DIR, wsDir, projectName);
}

// Find actual container name (devcontainer CLI chooses the name, not us)
const containerName = await findSessionContainer(projectName);
```

- [ ] **Step 6: Sync-skills picker shows sessions** — in the `sync-skills` block, replace `findContainer(workspace)` usage with workspace-filtered `findMoatContainers()`:

```js
if (subcommand === 'sync-skills') {
  const { findMoatContainers } = await import('./lib/container.mjs');
  ...
  const all = await findMoatContainers();
  const forWorkspace = all.filter(c => c.workspace === workspace);
  let containerName = null;
  let containerWorkspace = workspace;
  if (forWorkspace.length === 1) {
    containerName = forWorkspace[0].name;
  }
  if (!containerName) {
    const running = forWorkspace.length > 0 ? forWorkspace : all;
    if (running.length === 0) { /* existing error path unchanged */ }
    if (running.length === 1) {
      containerName = running[0].name;
      containerWorkspace = running[0].workspace;
    } else {
      log('Multiple moat sessions running. Which one?');
      for (let i = 0; i < running.length; i++) {
        console.log(`  \x1b[1m${i + 1}\x1b[0m) ${running[i].workspace}${running[i].session ? `  (${running[i].session})` : ''}`);
      }
      /* existing readline selection unchanged, sets containerName/containerWorkspace */
    }
  }
  ...
}
```

(Keep the existing readline code; only the candidate list and labels change.)

- [ ] **Step 7: Update help text** — in the help block add/adjust:

```
${BOLD}OPTIONS${RESET}
  --runtime <name>    Runtime to use (${runtimes}) ${DIM}[default: claude]${RESET}
  --name <label>      Stable session name (reuse/reconnect the same container)
  --add-dir <path>    Mount additional directory into the container (repeatable)
  --help, -h          Show this help message

${BOLD}COMMANDS${RESET}
  ...
  ${CYAN}attach${RESET} --name <label> [workspace]  Reconnect to a running named session
  ${CYAN}ps${RESET}                  List running moat sessions
  ${CYAN}down${RESET} [pattern]      Stop sessions for this workspace (picker if several)
    --name <label>    Stop a specific named session
    --all             Stop all sessions for the workspace
  ...

${BOLD}EXAMPLES${RESET}
  moat                                      ${DIM}# New session in current directory${RESET}
  moat ~/projects/myapp --name app0         ${DIM}# Named session (reusable)${RESET}
  moat attach --name app0 ~/projects/myapp  ${DIM}# Reconnect to it${RESET}
  ...
```

Note: every `moat` launch now starts a NEW container; remove/replace the old "Stop all containers" wording for `down --all`.

- [ ] **Step 8: Verify**

Run: `node --check moat.mjs && node moat.mjs help | head -40`
Expected: parses; help shows new options.

- [ ] **Step 9: Commit**

```bash
git add moat.mjs
git commit -m "feat: per-session containers with --name and attach"
```

---

### Task 5: `lib/down.mjs` — session-aware teardown

**Files:**
- Modify: `lib/down.mjs`

- [ ] **Step 1: Rewrite `down()`** semantics:
  - `--name <label>`: tear down `moat-<wsHash>-<label>` for the (cwd) workspace.
  - `--all`: tear down all sessions whose `workspace` matches the current workspace (per spec). Global wipe remains available via pattern: `moat down '*'`.
  - pattern: unchanged matching, but teardown per matched container.
  - no args: sessions for cwd workspace — 1 → stop it; >1 → interactive picker (existing UI, now labeled with session names); 0 → fall back to global list/picker.

Imports change: `import { teardownSession, findMoatContainers, findSessionContainer } from './container.mjs';` plus `import { workspaceId, sanitizeSessionName } from './workspace-id.mjs';`

New signature and body (the `interactiveSelect` helper stays, but item labels gain the session suffix):

```js
// In interactiveSelect render(), label each session with its suffix:
//   const wsName = basename(s.workspace || '') || s.name;
//   const label = s.session ? `${wsName} (${s.session})` : wsName;
// and use `label` where wsName was printed.

export async function down(repoDir, { all = false, workspace, pattern, name } = {}) {
  // --name <label>: stop one named session for this workspace
  if (name) {
    let suffix;
    try { suffix = sanitizeSessionName(name); } catch (e) { err(e.message); return; }
    const project = `moat-${workspaceId(workspace)}-${suffix}`;
    const container = await findSessionContainer(project);
    if (!container) {
      err(`No running session named '${suffix}' for this workspace.`);
      return;
    }
    log(`Tearing down session ${BOLD}${suffix}${RESET} (${container})...`);
    await teardownSession(container);
    if (!await anyMoatContainersRunning()) await stopProxy();
    log('Done.');
    return;
  }

  if (all) {
    const sessions = (await findMoatContainers()).filter(c => c.workspace === workspace);
    if (sessions.length === 0) {
      err(`No running sessions for ${workspace}.`);
      log(`Tip: 'moat down <pattern>' or 'moat down \\'*\\'' matches sessions in any workspace.`);
      return;
    }
    log(`Tearing down ${sessions.length} session${sessions.length === 1 ? '' : 's'} for ${BOLD}${basename(workspace)}${RESET}...`);
    if (commandExists('mutagen')) {
      await runCapture('mutagen', ['sync', 'terminate', '--label-selector', 'moat=true'], { allowFailure: true });
    }
    for (const c of sessions) {
      log(`  ${DIM}${c.name}${RESET}`);
      await teardownSession(c.name);
    }
    if (!await anyMoatContainersRunning()) await stopProxy();
    log('Done.');
    return;
  }

  // Pattern matching — unchanged matcher, but match session suffix too and
  // tear down per container:
  if (pattern) {
    /* keep existing regex/substring matching code, adding c.session to the
       fields tested:
         return regex.test(wsBase) || regex.test(c.workspace || '') ||
                regex.test(c.name) || (c.session && regex.test(c.session));
       and in the substring fallback:
         wsBase.includes(lower) || c.name.toLowerCase().includes(lower) ||
         (c.session && c.session.toLowerCase().includes(lower))
    */
    for (const c of matches) {
      log(`Tearing down ${BOLD}${basename(c.workspace || '')}${RESET}${c.session ? ` (${c.session})` : ''} [${c.name}]...`);
      await teardownSession(c.name);
    }
    if (!await anyMoatContainersRunning()) await stopProxy();
    log('Done.');
    return;
  }

  // No flags: prefer sessions for the current workspace
  const running = await findMoatContainers();
  if (running.length === 0) {
    err('No running moat sessions.');
    return;
  }
  const forWorkspace = running.filter(c => c.workspace === workspace);
  const candidates = forWorkspace.length > 0 ? forWorkspace : running;

  if (candidates.length === 1) {
    const c = candidates[0];
    log(`Tearing down ${BOLD}${basename(c.workspace || '')}${RESET}${c.session ? ` (${c.session})` : ''}...`);
    if (commandExists('mutagen')) {
      await runCapture('mutagen', ['sync', 'terminate', '--label-selector', 'moat=true'], { allowFailure: true });
    }
    await teardownSession(c.name);
    if (!await anyMoatContainersRunning()) await stopProxy();
    log('Done.');
    return;
  }

  // Non-TTY: list what's running
  if (!process.stdin.isTTY) {
    log('Multiple sessions running. Specify a pattern, --name, or --all.');
    for (const c of candidates) {
      console.log(`  ${DIM}${c.name}${RESET}  ${basename(c.workspace || '')}${c.session ? ` (${c.session})` : ''}`);
    }
    return;
  }

  const selected = await interactiveSelect(candidates);
  if (!selected) return;
  if (selected === 'all') {
    for (const c of candidates) {
      log(`Tearing down ${DIM}${c.name}${RESET}...`);
      await teardownSession(c.name);
    }
  } else {
    log(`Tearing down ${BOLD}${basename(selected.workspace || '')}${RESET}${selected.session ? ` (${selected.session})` : ''}...`);
    await teardownSession(selected.name);
  }
  if (!await anyMoatContainersRunning()) await stopProxy();
  log('Done.');
}
```

Note: the old `workspace`-arg final branch (explicit workspace teardown) is subsumed by the cwd filter; `down` is a raw subcommand so `workspace` is always cwd.

- [ ] **Step 2: Wire `--name` in `moat.mjs` down route**

```js
if (subcommand === 'down') {
  const allFlag = subcommandArgs.includes('--all');
  const nameIdx = subcommandArgs.indexOf('--name');
  const nameArg = nameIdx !== -1 ? subcommandArgs[nameIdx + 1] : null;
  // First non-flag arg (that isn't the --name value) is a pattern
  const pattern = subcommandArgs.find((a, i) => a !== '--all' && !a.startsWith('-') && i !== nameIdx + 1);
  await down(REPO_DIR, { all: allFlag, workspace, pattern, name: nameArg });
  process.exit(0);
}
```

- [ ] **Step 3: Verify**

Run: `node --check lib/down.mjs && node --check moat.mjs && node moat.mjs down` (with no containers running)
Expected: "No running moat sessions."

- [ ] **Step 4: Commit**

```bash
git add lib/down.mjs moat.mjs
git commit -m "feat: session-aware moat down (--name, workspace-scoped --all)"
```

---

### Task 6: Callers of per-workspace dirs — `attach.mjs`, `allow-domain.mjs`, remove legacy `teardown`/`findContainer`

**Files:**
- Modify: `lib/attach.mjs`, `lib/allow-domain.mjs`, `lib/container.mjs`

- [ ] **Step 1: `lib/attach.mjs`** — the data dir must come from the chosen container's session, not the workspace hash. Replace imports and the discovery/dir block:

```js
import { findMoatContainers, getContainerWorkspace, getExtraMountSources, teardownSession, startContainer, getComposeProject, sessionDirFromContainer } from './container.mjs';
// (drop findContainer, workspaceId, workspaceDataDir imports)
```

Discovery (replaces the `findContainer` + picker block):

```js
  const all = await findMoatContainers();
  const forWorkspace = all.filter(c => c.workspace === workspace);
  let containerName = forWorkspace.length === 1 ? forWorkspace[0].name : null;
  if (!containerName) {
    const running = forWorkspace.length > 0 ? forWorkspace : all;
    if (running.length === 0) {
      err("No running moat container. Start a session first with 'moat'.");
      process.exit(1);
    }
    if (running.length === 1) {
      containerName = running[0].name;
      workspace = running[0].workspace;
    } else {
      log('Multiple moat sessions running. Which one?');
      for (let i = 0; i < running.length; i++) {
        console.log(`  ${BOLD}${i + 1}${RESET}) ${running[i].workspace}${running[i].session ? `  (${running[i].session})` : ''}`);
      }
      const answer = await prompt(`\n  ${CYAN}?${RESET} Select session ${DIM}[1-${running.length}]${RESET} `);
      const idx = parseInt(answer, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= running.length) {
        err('Invalid selection.');
        process.exit(1);
      }
      containerName = running[idx].name;
      workspace = running[idx].workspace;
    }
  }

  const wsDataDir = await sessionDirFromContainer(containerName);
  if (!wsDataDir) {
    err('Cannot determine session data directory for this container.');
    process.exit(1);
  }
```

In the mutagen-less fallback branch, replace teardown/restart with:

```js
    const attachWorkspace = await getContainerWorkspace(containerName);
    const existingSources = await getExtraMountSources(containerName);
    const project = await getComposeProject(containerName);

    const overrideFile = `${wsDataDir}/docker-compose.extra-dirs.yml`;
    writeFileSync(overrideFile, generateExtraDirsYamlForAttach(existingSources, attachDir, attachName));

    log('Stopping container...');
    await teardownSession(containerName);

    log('Starting container with new mount...');
    await startContainer(attachWorkspace, repoDir, wsDataDir, project);
```

- [ ] **Step 2: `lib/allow-domain.mjs`** — same pattern. Replace imports:

```js
import { findMoatContainers, sessionDirFromContainer } from './container.mjs';
// drop findContainer, workspaceId, workspaceDataDir
```

Replace the discovery block with the same workspace-filtered picker as Step 1 (copy it verbatim, minus the attach-specific lines), then:

```js
  // Derive the session's data directory from the container labels
  const wsDataDir = await sessionDirFromContainer(containerName);
  if (!wsDataDir) {
    err('Cannot determine session data directory for this container.');
    process.exit(1);
  }
  const squidConfPath = `${wsDataDir}/squid-runtime.conf`;
  const extraDomainsPath = `${wsDataDir}/extra-domains.txt`;
```

The file's local `getComposeProject` helper stays (it's used for the squid lookup) — or import it from container.mjs and delete the local copy (preferred, DRY).

- [ ] **Step 3: Remove dead code from `lib/container.mjs`** — delete `teardown(workspace)` and `findContainer(workspace)` (now unused), verify:

Run: `grep -rn "findContainer\|teardown(" lib moat.mjs | grep -v teardownSession | grep -v findMoatContainers | grep -v findSessionContainer`
Expected: no remaining callers (docs references handled in Task 8).

- [ ] **Step 4: Verify**

Run: `node --check lib/attach.mjs && node --check lib/allow-domain.mjs && node --check lib/container.mjs && node --test test/`
Expected: parses; unit tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/attach.mjs lib/allow-domain.mjs lib/container.mjs
git commit -m "refactor: derive session data dir from container labels"
```

---

### Task 7: `lib/ps.mjs` — sessions grouped by workspace with name/uptime/CPU/mem

**Files:**
- Modify: `lib/ps.mjs`

- [ ] **Step 1: Rewrite `ps()`**

```js
// ps subcommand — list running moat sessions
import { basename } from 'node:path';
import { BOLD, DIM, RESET } from './colors.mjs';
import { runCapture } from './exec.mjs';
import { findMoatContainers } from './container.mjs';

export async function ps() {
  const sessions = await findMoatContainers();
  if (sessions.length === 0) {
    console.log('No running moat sessions.');
    return;
  }

  // Uptime/status per container
  const statusResult = await runCapture('docker', [
    'ps', '--filter', 'label=devcontainer.local_folder',
    '--format', '{{.Names}}\t{{.Status}}',
  ], { allowFailure: true });
  const statusByName = {};
  for (const line of statusResult.stdout.trim().split('\n').filter(Boolean)) {
    const [n, s] = line.split('\t');
    statusByName[n] = s;
  }

  // CPU/mem per container (single stats call)
  const statsResult = await runCapture('docker', [
    'stats', '--no-stream', '--filter', 'name=moat-',
    '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}',
  ], { allowFailure: true });
  const statsByName = {};
  for (const line of statsResult.stdout.trim().split('\n').filter(Boolean)) {
    const [n, cpu, mem] = line.split('\t');
    statsByName[n] = { cpu, mem };
  }

  // Group sessions by workspace
  const byWorkspace = new Map();
  for (const s of sessions) {
    const key = s.workspace || '(unknown)';
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key).push(s);
  }

  console.log('');
  for (const [workspace, list] of byWorkspace) {
    console.log(`${BOLD}${workspace}${RESET}`);
    for (const s of list) {
      const status = statusByName[s.name] || '';
      const stats = statsByName[s.name];
      const sessionLabel = s.session || 'legacy';
      const resources = stats ? `  cpu ${stats.cpu}  mem ${stats.mem}` : '';
      console.log(`  ${BOLD}${sessionLabel.padEnd(12)}${RESET} ${status}${resources}`);
      console.log(`  ${DIM}${''.padEnd(12)} ${s.name}${RESET}`);

      // Agents scoped to this session via moat.workspace_hash label
      const sid = s.project.startsWith('moat-') ? s.project.slice(5) : null;
      if (sid) {
        const agentResult = await runCapture('docker', [
          'ps', '--filter', `label=moat.workspace_hash=${sid}`,
          '--filter', 'name=moat-agent-',
          '--format', '{{.Names}}',
        ], { allowFailure: true });
        const agents = agentResult.stdout.trim().split('\n').filter(Boolean);
        if (agents.length > 0) {
          console.log(`  ${DIM}${''.padEnd(12)} agents: ${agents.length} running${RESET}`);
        }
      }
    }
    console.log('');
  }
}
```

- [ ] **Step 2: Verify**

Run: `node --check lib/ps.mjs && node moat.mjs ps`
Expected: parses; "No running moat sessions." (or a session list if any are up).

- [ ] **Step 3: Commit**

```bash
git add lib/ps.mjs
git commit -m "feat: moat ps shows per-session name, uptime, cpu/mem"
```

---

### Task 8: `lib/rewind.mjs` aggregation + docs

**Files:**
- Modify: `lib/rewind.mjs`, `README.md`, `docs/setup.md`

- [ ] **Step 1: Aggregate audit logs across session dirs in `rewind.mjs`** — replace the single-dir block in `listRecoveryPoints`:

```js
  // 2. Session boundaries from audit logs (per-workspace legacy dir + per-session dirs)
  const hash = workspaceId(workspace);
  const wsRoot = join(process.env.HOME, '.moat', 'data', 'workspaces');
  let auditDirs = [];
  try {
    auditDirs = readdirSync(wsRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && (e.name === hash || e.name.startsWith(`${hash}-`)))
      .map(e => join(wsRoot, e.name));
  } catch {}
  for (const auditDir of auditDirs) {
    if (!existsSync(join(auditDir, 'audit.jsonl'))) continue;
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
```

(`workspaceDataDir` import becomes unused in this file — remove it. `readdirSync` is already imported.)

- [ ] **Step 2: README** — in the section that describes launching (around the examples), document sessions:

```markdown
### Sessions

Every `moat` launch gets its own container, so several agents can work on the
same workspace concurrently — each with its own 8 CPU / 16G limits. Worktrees
handle file-level isolation; the same workspace directory is mounted in all
session containers.

```bash
moat ~/Projects/myapp                     # new session with a random ID (e.g. a3f2)
moat ~/Projects/myapp --name session1      # named session — reuses the same container
moat attach --name session1        # reconnect to a running named session
moat ps                           # list sessions (name, uptime, cpu/mem)
moat down                         # stop a session for this workspace (picker)
moat down --name session1          # stop a named session
moat down --all                   # stop all sessions for this workspace
```
```

- [ ] **Step 3: docs/setup.md line ~338** — update the teardown description:

```markdown
Automatic on exit. `teardownSession()` in `lib/container.mjs` stops the session's
agent containers (by Docker label `moat.workspace_hash=<session-id>`), tears down
the session's compose project, and removes the per-session config volume for
unnamed sessions. `moat down --all` removes all sessions for the workspace;
`moat down '*'` matches every session in any workspace.
```

- [ ] **Step 4: Verify + commit**

Run: `node --check lib/rewind.mjs && node --test test/`

```bash
git add lib/rewind.mjs README.md docs/setup.md
git commit -m "docs: per-session containers; rewind aggregates session audit logs"
```

---

### Task 9: Full verification

- [ ] **Step 1: Unit tests + syntax**

```bash
node --test test/
for f in moat.mjs lib/*.mjs; do node --check "$f"; done
```
Expected: all tests PASS, all files parse.

- [ ] **Step 2: CLI smoke tests (no docker needed)**

```bash
node moat.mjs help            # shows --name, attach, updated down/ps
node moat.mjs down            # "No running moat sessions." (if none)
node moat.mjs ps              # "No running moat sessions." (if none)
node moat.mjs attach          # usage error: --name required
node moat.mjs --name '!!!' --help || true   # help wins; then:
node moat.mjs badcmd          # still "Unknown command"
```

- [ ] **Step 3: Docker smoke (only if docker is up and image already built — skip otherwise, note in PR):** start one unnamed session non-interactively is not practical (interactive runtime); instead verify identity plumbing by checking that `moat ps`/`down` behave with any currently running legacy containers.

- [ ] **Step 4: Commit any fixes, then create the PR** (use the git-pr flow): push branch, open PR titled "feat: separate container per session" summarizing requirements 1–8 and the `down --all` semantics change.

---

## Self-Review Notes

- **Req 1/2 (own container, random ID):** Task 4 Step 3 — random suffix, fresh project name each launch; reuse only via `--name`/`attach`.
- **Req 3 (`--name`):** Tasks 2 + 4.
- **Req 4 (`moat attach --name`):** Tasks 2 + 4 Step 2.
- **Req 5 (`down` / `down --all`):** Task 5. NOTE: `down --all` changes from "all moat containers globally" to "all sessions for this workspace" per spec; global wipe via `moat down '*'`. Help/docs updated (Tasks 4/8).
- **Req 6 (`ps`):** Task 7 — name, uptime (docker Status), CPU/mem (docker stats).
- **Req 7 (per-container limits):** Task 0 commits the 8CPU/16G bump; unique compose projects make limits per-container automatically.
- **Req 8 (same workspace mounted):** unchanged — `MOAT_WORKSPACE` bind mount per project.
- **Proxy/audit/agents:** per-session for free via `MOAT_WORKSPACE_HASH = <sessionId>` and per-session data dirs; `rewind` aggregates (Task 8); `moat audit` lists session dirs as-is (acceptable).
- **Legacy:** old `moat-<hash8>` containers remain discoverable (`session: ''` → shown as "legacy") and teardown-able via project label; legacy `moat-devcontainer-1` migration block untouched.
- **Volume hygiene:** random-session config volumes removed in `teardownSession`; named ones kept for `--continue`.
