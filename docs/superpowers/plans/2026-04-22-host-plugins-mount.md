# Host Plugins Mount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make host-installed Claude Code plugins (superpowers, etc.) visible inside every moat container via a read-only bind mount of `~/.claude/plugins/` — zero install, zero copy overhead.

**Architecture:** New `lib/plugins.mjs` exports `generatePluginsYaml(hostPluginsDir)` — a pure YAML string generator matching `generateDockerYaml` / `generateExtraDirsYaml` in `lib/compose.mjs`. `moat.mjs` calls it during session-start, writes `docker-compose.plugins.yml` to the per-workspace data dir, and appends it to the compose arg list. If the host plugins dir is missing or empty, the override is a no-op so compose-up never fails.

**Tech Stack:** Node.js (ESM, no build step), Docker Compose, node built-in `node:test` runner, bash test suite.

**Spec:** `docs/superpowers/specs/2026-04-22-host-plugins-mount-design.md`

---

## File Structure

- **`lib/plugins.mjs`** — new; one exported function `generatePluginsYaml(hostPluginsDir)` returning a YAML string. Pure; no I/O. Follows `generateExtraDirsYaml` / `generateDockerYaml` patterns in `lib/compose.mjs`.
- **`lib/plugins.test.mjs`** — new; unit tests via `node:test`. Non-empty host dir → YAML with bind mount. Missing or empty host dir → no-op YAML.
- **`moat.mjs`** — modify; import `generatePluginsYaml`, write override file in the session-start config phase, append to `composeFiles`.
- **`test.sh`** — modify; add `--docker-compose-file` flag for the plugins override to every `devcontainer up` / `devcontainer exec` invocation in the container phase, plus a new assertion that `/home/node/.claude/plugins/` is mounted and populated inside the container.
- **`lib/doctor.mjs`** — modify; add a minimal info check for the host plugins dir.

No changes to `Dockerfile`, `install.sh`, `squid.conf`, `tool-proxy.mjs`, `lib/skills.mjs`.

---

## Task 1: `generatePluginsYaml` with unit tests

**Files:**
- Create: `lib/plugins.mjs`
- Create: `lib/plugins.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `lib/plugins.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePluginsYaml } from './plugins.mjs';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'moat-plugins-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('non-empty host dir produces read-only bind mount', () => {
  withTmp((tmp) => {
    const plugins = join(tmp, 'plugins');
    mkdirSync(plugins);
    writeFileSync(join(plugins, 'installed_plugins.json'), '{}');

    const yaml = generatePluginsYaml(plugins);

    assert.match(yaml, /^services:/m);
    assert.match(yaml, /devcontainer:/);
    assert.match(yaml, /volumes:/);
    assert.match(yaml, new RegExp(`${plugins}:/home/node/\\.claude/plugins:ro`));
  });
});

test('missing host dir produces no-op override', () => {
  const yaml = generatePluginsYaml('/nonexistent/path/that/does/not/exist');
  assert.equal(yaml, 'services:\n  devcontainer: {}\n');
});

test('empty host dir produces no-op override', () => {
  withTmp((tmp) => {
    const plugins = join(tmp, 'plugins');
    mkdirSync(plugins);
    const yaml = generatePluginsYaml(plugins);
    assert.equal(yaml, 'services:\n  devcontainer: {}\n');
  });
});

test('output always ends with a single newline', () => {
  const yaml = generatePluginsYaml('/nonexistent');
  assert.ok(yaml.endsWith('\n'));
  assert.ok(!yaml.endsWith('\n\n'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/plugins.test.mjs`
Expected: FAIL with `Cannot find module './plugins.mjs'` or similar import error.

- [ ] **Step 3: Implement `generatePluginsYaml`**

Create `lib/plugins.mjs`:

```javascript
// Generate docker-compose.plugins.yml — bind-mounts the host's ~/.claude/plugins/
// read-only into the container so host-installed Claude Code plugins
// (superpowers, etc.) are visible inside moat without a copy step.

import { existsSync, readdirSync } from 'node:fs';

const NOOP = 'services:\n  devcontainer: {}\n';

/**
 * Generate compose override YAML for the plugins bind mount.
 * If the host dir is missing or empty, returns a no-op override so
 * `docker compose -f ... -f docker-compose.plugins.yml` always works.
 * @param {string} hostPluginsDir — absolute path to ~/.claude/plugins on host
 * @returns {string} YAML content
 */
export function generatePluginsYaml(hostPluginsDir) {
  if (!existsSync(hostPluginsDir)) return NOOP;
  try {
    if (readdirSync(hostPluginsDir).length === 0) return NOOP;
  } catch {
    return NOOP;
  }

  return [
    'services:',
    '  devcontainer:',
    '    volumes:',
    `      - ${hostPluginsDir}:/home/node/.claude/plugins:ro`,
  ].join('\n') + '\n';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/plugins.test.mjs`
Expected: PASS — all 4 tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add lib/plugins.mjs lib/plugins.test.mjs
git commit -m "feat: add generatePluginsYaml for host plugins mount"
```

---

## Task 2: Wire into `moat.mjs` session start

**Files:**
- Modify: `moat.mjs:13` (add import)
- Modify: `moat.mjs:~369` (write override file after `docker-compose.extra-dirs.yml`)
- Modify: `moat.mjs:454-459` (add override to `composeFiles` list)

- [ ] **Step 1: Add import**

Edit `moat.mjs` line 13 — add `generatePluginsYaml` to the compose import, OR add a new import line. Since `generatePluginsYaml` lives in its own module, add a new import after line 13:

Before (line 13):
```javascript
import { generateProjectConfig, generateExtraDirsYaml } from './lib/compose.mjs';
```

After (line 13–14):
```javascript
import { generateProjectConfig, generateExtraDirsYaml } from './lib/compose.mjs';
import { generatePluginsYaml } from './lib/plugins.mjs';
```

- [ ] **Step 2: Write the override file during session start**

Find the block that writes `docker-compose.extra-dirs.yml` (currently around line 368–369):

```javascript
// Generate docker-compose override for extra directories into wsDir
writeFileSync(join(wsDir, 'docker-compose.extra-dirs.yml'), generateExtraDirsYaml(extraDirs));
```

Add immediately after it (new block, before the extra-dirs log block at ~line 371):

```javascript
// Generate docker-compose override for host plugins bind mount
const hostPluginsDir = join(process.env.HOME, '.claude', 'plugins');
writeFileSync(join(wsDir, 'docker-compose.plugins.yml'), generatePluginsYaml(hostPluginsDir));
```

`join` is already imported from `node:path` at the top of `moat.mjs` — no new imports needed.

- [ ] **Step 3: Add override to `composeFiles` list**

Find the list at lines 454–459:

```javascript
const composeFiles = [
  `${REPO_DIR}/docker-compose.yml`,
  `${wsDir}/docker-compose.volumes.yml`,
  `${wsDir}/docker-compose.services.yml`,
  `${wsDir}/docker-compose.extra-dirs.yml`,
];
```

Change to:

```javascript
const composeFiles = [
  `${REPO_DIR}/docker-compose.yml`,
  `${wsDir}/docker-compose.volumes.yml`,
  `${wsDir}/docker-compose.services.yml`,
  `${wsDir}/docker-compose.extra-dirs.yml`,
  `${wsDir}/docker-compose.plugins.yml`,
];
```

Order matters only for conflicting keys — later files override earlier. Placing `plugins.yml` last means a bind mount in it wins over any conflicting service mount, which is what we want.

- [ ] **Step 4: Smoke-test the integration**

Launch a throwaway moat session against a scratch workspace and confirm the override file is generated:

```bash
# In a tmpdir, run moat briefly (Ctrl+C after the banner to avoid a full session):
cd /tmp && mkdir -p moat-scratch && cd moat-scratch && git init -q
moat . &
MOAT_PID=$!
sleep 15
kill $MOAT_PID 2>/dev/null

# Check the generated file exists and has content:
WSDIR=$(ls -td ~/.moat/data/workspaces/*/ | head -1)
cat "$WSDIR/docker-compose.plugins.yml"
```

Expected: YAML containing `/Users/<you>/.claude/plugins:/home/node/.claude/plugins:ro` (or a no-op override if host dir is empty).

If the file is not generated or moat errors at startup, fix before committing.

- [ ] **Step 5: Commit**

```bash
git add moat.mjs
git commit -m "feat: wire generatePluginsYaml into session-start compose files"
```

---

## Task 3: Add plugins override to `test.sh` and verify the mount

**Files:**
- Modify: `test.sh` (lines ~62, 65–68, 739–747, 753–761, 777–785, and `dc_exec` helper)
- Add: new phase asserting the plugins mount after `--- Phase 6b ---`

- [ ] **Step 1: Add plugins override file to test setup**

Find lines 58–63:

```bash
# Ensure token is in repo for build context
cp "$TOKEN_FILE" "$SCRIPT_DIR/.proxy-token"

# Ensure override files exist
printf 'services:\n  devcontainer: {}\n' > "$OVERRIDE_FILE"
printf 'services:\n  devcontainer: {}\n' > "$SERVICES_FILE"
```

Edit `test.sh`. At line 13 (right after `SERVICES_FILE="..."`), add a new variable:

```bash
PLUGINS_FILE="$SCRIPT_DIR/docker-compose.plugins.yml"
```

Then, in the override-init block at lines 62–63, add a third line:

Before:
```bash
printf 'services:\n  devcontainer: {}\n' > "$OVERRIDE_FILE"
printf 'services:\n  devcontainer: {}\n' > "$SERVICES_FILE"
```

After:
```bash
printf 'services:\n  devcontainer: {}\n' > "$OVERRIDE_FILE"
printf 'services:\n  devcontainer: {}\n' > "$SERVICES_FILE"
printf 'services:\n  devcontainer: {}\n' > "$PLUGINS_FILE"
```

(Starts as a no-op override so earlier phases don't depend on the host having `~/.claude/plugins/`. Phase 6c will rewrite it to test the real mount.)

(Start with the no-op override so tests don't depend on the host having `~/.claude/plugins/`. We'll override it in the plugins-mount phase.)

- [ ] **Step 2: Add plugins override flag to `devcontainer up` (Phase 6)**

Find lines 739–747:

```bash
devcontainer up \
  --workspace-folder "$WORKSPACE" \
  --config "$SCRIPT_DIR/devcontainer.json" \
  --docker-compose-file "$SCRIPT_DIR/docker-compose.yml" \
  --docker-compose-file "$SERVICES_FILE" \
  --docker-compose-file "$OVERRIDE_FILE" \
  --project-name "$PROJECT_NAME" >/dev/null 2>&1
```

Add a `--docker-compose-file "$PLUGINS_FILE"` line before `--project-name`:

```bash
devcontainer up \
  --workspace-folder "$WORKSPACE" \
  --config "$SCRIPT_DIR/devcontainer.json" \
  --docker-compose-file "$SCRIPT_DIR/docker-compose.yml" \
  --docker-compose-file "$SERVICES_FILE" \
  --docker-compose-file "$OVERRIDE_FILE" \
  --docker-compose-file "$PLUGINS_FILE" \
  --project-name "$PROJECT_NAME" >/dev/null 2>&1
```

- [ ] **Step 3: Add plugins override flag to subsequent `devcontainer exec` invocations**

Apply the same `--docker-compose-file "$PLUGINS_FILE"` addition to:
- The `devcontainer exec ... verify.sh` block at lines 753–761.
- The `dc_exec()` helper at lines 776–785.

For `dc_exec()` the final shape is:

```bash
dc_exec() {
  devcontainer exec \
    --workspace-folder "$WORKSPACE" \
    --config "$SCRIPT_DIR/devcontainer.json" \
    --docker-compose-file "$SCRIPT_DIR/docker-compose.yml" \
    --docker-compose-file "$SERVICES_FILE" \
    --docker-compose-file "$OVERRIDE_FILE" \
    --docker-compose-file "$PLUGINS_FILE" \
    --project-name "$PROJECT_NAME" \
    "$@" 2>&1
}
```

- [ ] **Step 4: Add a new Phase 6c asserting the mount works**

Insert a new phase block after Phase 6b (before `--- Phase 7` / `--- Phase 8`). Locate `--- Phase 7` in the file — insert above it:

```bash
# --- Phase 6c: Host plugins mount ---
echo ""
echo "--- Phase 6c: Host plugins mount ---"

# Case A: no-op override (default for this test suite) — the plugins dir
# inside the container should either not exist or be empty/unchanged.
# Skip Case A; the meaningful assertion is Case B below.

# Case B: real mount — regenerate PLUGINS_FILE with a populated fake host dir,
# tear down + bring up the container, and verify the mount is visible.
FAKE_PLUGINS_DIR="$DATA_DIR/fake-host-plugins"
rm -rf "$FAKE_PLUGINS_DIR"
mkdir -p "$FAKE_PLUGINS_DIR/cache/test-marketplace/test-plugin/1.0.0"
echo '{"name":"test-plugin"}' > "$FAKE_PLUGINS_DIR/cache/test-marketplace/test-plugin/1.0.0/plugin.json"
echo '{"version":2,"plugins":{}}' > "$FAKE_PLUGINS_DIR/installed_plugins.json"

# Use generatePluginsYaml (via a tiny node one-liner) to generate the override.
node -e "
import('$SCRIPT_DIR/lib/plugins.mjs').then(m => {
  process.stdout.write(m.generatePluginsYaml('$FAKE_PLUGINS_DIR'));
});
" > "$PLUGINS_FILE"

if grep -q "$FAKE_PLUGINS_DIR:/home/node/.claude/plugins:ro" "$PLUGINS_FILE"; then
  pass "generatePluginsYaml produced bind-mount override for populated host dir"
else
  fail "generatePluginsYaml did not produce expected bind mount"
  cat "$PLUGINS_FILE"
fi

# Restart the container to pick up the new compose override.
devcontainer up \
  --workspace-folder "$WORKSPACE" \
  --config "$SCRIPT_DIR/devcontainer.json" \
  --docker-compose-file "$SCRIPT_DIR/docker-compose.yml" \
  --docker-compose-file "$SERVICES_FILE" \
  --docker-compose-file "$OVERRIDE_FILE" \
  --docker-compose-file "$PLUGINS_FILE" \
  --project-name "$PROJECT_NAME" >/dev/null 2>&1

# Verify the plugin file is visible inside the container.
PLUGIN_JSON=$(dc_exec bash -c 'cat /home/node/.claude/plugins/cache/test-marketplace/test-plugin/1.0.0/plugin.json' 2>&1) || true
if echo "$PLUGIN_JSON" | grep -q '"name":"test-plugin"'; then
  pass "host plugins mounted read-only inside container"
else
  fail "host plugins not visible inside container: $PLUGIN_JSON"
fi

# Verify the mount is read-only.
WRITE_ATTEMPT=$(dc_exec bash -c 'echo mutated > /home/node/.claude/plugins/mutation-test.txt 2>&1; echo EXIT=$?' 2>&1) || true
if echo "$WRITE_ATTEMPT" | grep -qE "Read-only file system|Permission denied" && echo "$WRITE_ATTEMPT" | grep -qv "EXIT=0"; then
  pass "plugins mount is read-only (write blocked)"
else
  fail "plugins mount is NOT read-only: $WRITE_ATTEMPT"
fi

# Reset override to no-op so later phases aren't affected.
printf 'services:\n  devcontainer: {}\n' > "$PLUGINS_FILE"
rm -rf "$FAKE_PLUGINS_DIR"
```

- [ ] **Step 5: Run the test suite**

Run: `./test.sh`
Expected: All existing phases still pass; new Phase 6c reports 3 passes. The final summary shows no regressions.

If a phase after 6c fails because of the container being restarted without a subsequent teardown, inspect and fix before committing — e.g., verify that Phase 7 and Phase 8 don't depend on container-internal state modified by 6c.

- [ ] **Step 6: Commit**

```bash
git add test.sh
git commit -m "test: cover host plugins bind mount in e2e suite"
```

---

## Task 4: Empirical check — does Claude Code find the mounted plugins?

This task answers the path-rewrite question flagged in the spec. The output determines whether Task 5 is needed.

**Files:** none modified; this is a manual verification run.

- [ ] **Step 1: Launch a real moat session**

```bash
mkdir -p /tmp/moat-plugin-check && cd /tmp/moat-plugin-check && git init -q
moat .
```

- [ ] **Step 2: Inside the container, confirm the plugin dir is mounted**

Inside the moat session shell (`[moat] node@...` prompt):

```bash
ls /home/node/.claude/plugins/cache/claude-plugins-official/superpowers/
```

Expected: directory listing with the superpowers version subdirectory (`5.0.7/` or similar).

- [ ] **Step 3: Inside the container, check Claude Code sees the plugin**

Launch `claude` inside the container. In Claude Code's REPL, type `/plugin` and look at the list, or ask: "what skills do you have?" and check whether superpowers skills (e.g. `superpowers:brainstorming`) appear.

**Record the outcome** in this plan (edit this file):

- [ ] **Outcome A — plugins load from scan:** superpowers skills are visible inside the container. No further work needed. Task 5 is skipped.
- [ ] **Outcome B — plugins require path rewriting:** skills are NOT visible, or errors reference `/Users/<host-user>/...` paths. Task 5 is required.

- [ ] **Step 4: Exit the container and commit the outcome note**

Append the finding to the spec file (`docs/superpowers/specs/2026-04-22-host-plugins-mount-design.md`) under a new `## Verification outcome` section:

```markdown
## Verification outcome

Tested on 2026-04-22 against superpowers 5.0.7 and Claude Code <version>.
**Result:** <Outcome A: scan-based loading works | Outcome B: path rewriting required>
**Evidence:** <what was / wasn't visible, any error messages>
```

Commit:

```bash
git add docs/superpowers/specs/2026-04-22-host-plugins-mount-design.md
git commit -m "docs: record plugin-loader verification outcome"
```

If Outcome B, proceed to Task 5. If Outcome A, skip Task 5.

---

## Task 5: Path-rewrite fallback (only if Task 4 → Outcome B)

**Trigger:** Task 4 verified Outcome B — Claude Code uses `installPath` strings from `installed_plugins.json` literally and the host path doesn't resolve inside the container.

**Approach:** Split the mount so plugin *content* stays read-only but the manifest can be rewritten. Bind-mount only `~/.claude/plugins/cache/` (the actual plugin files) read-only to `/home/node/.claude/plugins/cache/`, and `docker cp` a rewritten copy of `installed_plugins.json` into `/home/node/.claude/plugins/installed_plugins.json` (lives in the `moat-config` named volume, so it's container-writable). Other host-side files under `~/.claude/plugins/` (e.g. `marketplaces/`) get the same treatment if they have absolute paths — default to bind-mounting them read-only too.

**Files:**
- Modify: `lib/plugins.mjs` — change mount source from `~/.claude/plugins` to `~/.claude/plugins/cache` (keep `:ro`), add exported `rewriteInstalledPlugins` and `syncPluginManifest` functions
- Modify: `moat.mjs` — call `syncPluginManifest` after container is up, alongside `copySkills` / `copyCommands`
- Modify: `lib/plugins.test.mjs` — update the mount-path assertion from `/plugins:ro` to `/plugins/cache:ro`, add tests for `rewriteInstalledPlugins`

- [ ] **Step 1: Write a failing test for path rewriting**

Add to `lib/plugins.test.mjs`:

```javascript
import { rewriteInstalledPlugins } from './plugins.mjs';

test('rewriteInstalledPlugins replaces host HOME prefix with container path', () => {
  const input = JSON.stringify({
    version: 2,
    plugins: {
      'superpowers@claude-plugins-official': [{
        scope: 'user',
        installPath: '/Users/alice/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7',
        version: '5.0.7'
      }]
    }
  });
  const out = rewriteInstalledPlugins(input, '/Users/alice', '/home/node');
  const parsed = JSON.parse(out);
  assert.equal(
    parsed.plugins['superpowers@claude-plugins-official'][0].installPath,
    '/home/node/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7'
  );
});

test('rewriteInstalledPlugins leaves unrelated paths untouched', () => {
  const input = JSON.stringify({ other: '/Users/bob/elsewhere' });
  const out = rewriteInstalledPlugins(input, '/Users/alice', '/home/node');
  assert.deepEqual(JSON.parse(out), { other: '/Users/bob/elsewhere' });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `node --test lib/plugins.test.mjs`
Expected: FAIL — `rewriteInstalledPlugins is not a function`.

- [ ] **Step 3: Implement `rewriteInstalledPlugins`**

Append to `lib/plugins.mjs`:

```javascript
/**
 * Rewrite absolute paths in installed_plugins.json from the host's $HOME
 * to the container's /home/node. Only exact prefix matches are replaced
 * to avoid touching unrelated paths.
 * @param {string} json — file contents
 * @param {string} hostHome — e.g. /Users/alice
 * @param {string} containerHome — e.g. /home/node
 * @returns {string} rewritten JSON
 */
export function rewriteInstalledPlugins(json, hostHome, containerHome) {
  const data = JSON.parse(json);
  function walk(obj) {
    if (typeof obj === 'string') {
      return obj.startsWith(hostHome + '/') ? containerHome + obj.slice(hostHome.length) : obj;
    }
    if (Array.isArray(obj)) return obj.map(walk);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'installPath' && typeof v === 'string' && v.startsWith(hostHome + '/')) {
          out[k] = containerHome + v.slice(hostHome.length);
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    return obj;
  }
  return JSON.stringify(walk(data), null, 2);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test lib/plugins.test.mjs`
Expected: PASS for all tests including the two new ones.

- [ ] **Step 5: Narrow the mount to `cache/` only (preserves `:ro`)**

Edit `generatePluginsYaml` in `lib/plugins.mjs`. Change the emptiness check to look at `cache/` and the mount line to bind only `cache/`:

```javascript
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const NOOP = 'services:\n  devcontainer: {}\n';

export function generatePluginsYaml(hostPluginsDir) {
  const cacheDir = join(hostPluginsDir, 'cache');
  if (!existsSync(cacheDir)) return NOOP;
  try {
    if (readdirSync(cacheDir).length === 0) return NOOP;
  } catch {
    return NOOP;
  }

  return [
    'services:',
    '  devcontainer:',
    '    volumes:',
    `      - ${cacheDir}:/home/node/.claude/plugins/cache:ro`,
  ].join('\n') + '\n';
}
```

Update the corresponding assertion in `lib/plugins.test.mjs`. The existing non-empty test must now populate `cache/` rather than the top-level dir:

```javascript
test('non-empty host cache dir produces read-only bind mount of cache/', () => {
  withTmp((tmp) => {
    const plugins = join(tmp, 'plugins');
    const cache = join(plugins, 'cache');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'marker'), 'x');

    const yaml = generatePluginsYaml(plugins);
    assert.match(yaml, new RegExp(`${cache}:/home/node/\\.claude/plugins/cache:ro`));
  });
});
```

Also update the "empty host dir" test to create `plugins/` without `cache/` and assert the no-op response. Remove the old "empty host dir" test or update it:

```javascript
test('host plugins dir without cache/ produces no-op override', () => {
  withTmp((tmp) => {
    const plugins = join(tmp, 'plugins');
    mkdirSync(plugins);
    assert.equal(generatePluginsYaml(plugins), 'services:\n  devcontainer: {}\n');
  });
});
```

- [ ] **Step 6: Implement `syncPluginManifest`**

Append to `lib/plugins.mjs`:

```javascript
import { readFileSync, writeFileSync as _writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCapture } from './exec.mjs';

/**
 * After container start, rewrite the host's installed_plugins.json to use
 * the container's home prefix and docker-cp it into place.
 * Non-fatal — plugins may still partially work without this on some loader
 * implementations.
 * @param {string} containerName
 */
export async function syncPluginManifest(containerName) {
  const hostHome = process.env.HOME;
  const containerHome = '/home/node';
  const manifestPath = join(hostHome, '.claude', 'plugins', 'installed_plugins.json');

  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return; // No manifest on host — nothing to sync
  }

  const rewritten = rewriteInstalledPlugins(raw, hostHome, containerHome);
  const tmpFile = join(tmpdir(), `moat-installed-plugins-${process.pid}.json`);
  _writeFileSync(tmpFile, rewritten);
  try {
    await runCapture('docker', [
      'cp', tmpFile,
      `${containerName}:/home/node/.claude/plugins/installed_plugins.json`,
    ]);
  } catch {
    // Non-fatal
  }
}
```

- [ ] **Step 7: Call `syncPluginManifest` from `moat.mjs` after container start**

Find the section of `moat.mjs` that calls `copySkills` / `copyCommands` after the container is up. Add `syncPluginManifest` alongside them:

Before:
```javascript
await copySkills(containerName);
await copyCommands(containerName);
```

After:
```javascript
await copySkills(containerName);
await copyCommands(containerName);
const { syncPluginManifest } = await import('./lib/plugins.mjs');
await syncPluginManifest(containerName);
```

(The existing moat pattern uses dynamic imports in this area — follow the established style.)

- [ ] **Step 8: Re-run Task 4 verification**

Launch `moat` against a scratch dir again and confirm superpowers skills are now visible inside the container. If still not, investigate `installed_plugins.json` contents inside the container (`cat /home/node/.claude/plugins/installed_plugins.json`) and any Claude Code plugin-loader error messages.

- [ ] **Step 9: Update Phase 6c tests for the new mount layout**

The existing Phase 6c creates `$FAKE_PLUGINS_DIR/cache/test-marketplace/test-plugin/1.0.0/plugin.json` — that still works because we now mount `cache/`. But the read-only assertion writes to `/home/node/.claude/plugins/mutation-test.txt` which is no longer on a read-only mount. Update the assertion to write *inside* `cache/`:

```bash
WRITE_ATTEMPT=$(dc_exec bash -c 'echo mutated > /home/node/.claude/plugins/cache/mutation-test.txt 2>&1; echo EXIT=$?' 2>&1) || true
if echo "$WRITE_ATTEMPT" | grep -qE "Read-only file system|Permission denied" && echo "$WRITE_ATTEMPT" | grep -qv "EXIT=0"; then
  pass "plugins cache mount is read-only (write blocked)"
else
  fail "plugins cache mount is NOT read-only: $WRITE_ATTEMPT"
fi
```

Add a new assertion that the manifest was rewritten:

```bash
MANIFEST=$(dc_exec bash -c 'cat /home/node/.claude/plugins/installed_plugins.json 2>/dev/null || echo MISSING' 2>&1) || true
if echo "$MANIFEST" | grep -q '/home/node/.claude/plugins/'; then
  pass "installed_plugins.json rewritten to container paths"
elif [ "$MANIFEST" = "MISSING" ]; then
  info "installed_plugins.json not present in container — skipping rewrite check"
else
  fail "installed_plugins.json not rewritten: $MANIFEST"
fi
```

Note: Phase 6c's current FAKE_PLUGINS_DIR setup writes an empty `installed_plugins.json` (no real plugins), so the rewrite is a no-op on this test data — the grep will not match `/home/node/...`. To make this assertion meaningful, change the Phase 6c setup to include a host-style path. Update the line:

```bash
echo '{"version":2,"plugins":{}}' > "$FAKE_PLUGINS_DIR/installed_plugins.json"
```

to:

```bash
cat > "$FAKE_PLUGINS_DIR/installed_plugins.json" <<EOF
{
  "version": 2,
  "plugins": {
    "test-plugin@test-marketplace": [{
      "scope": "user",
      "installPath": "$FAKE_PLUGINS_DIR/cache/test-marketplace/test-plugin/1.0.0",
      "version": "1.0.0"
    }]
  }
}
EOF
```

After `syncPluginManifest` runs, the container copy should have `installPath` rewritten from `$FAKE_PLUGINS_DIR/cache/...` to `/home/node/.claude/plugins/cache/...`. However, the rewrite is prefix-anchored on `$HOME/.claude`, and `$FAKE_PLUGINS_DIR` lives under `$DATA_DIR` = `$HOME/.moat/data/...`. The prefix won't match. Accept this limitation in the test by making it a no-op-but-non-fatal check, or skip the rewrite assertion in the test (it's exercised by the unit tests in `lib/plugins.test.mjs`). Remove the rewrite assertion from Phase 6c and keep it as a pure unit-test concern:

```bash
# (Rewrite assertion intentionally omitted — unit-tested in lib/plugins.test.mjs;
# Phase 6c covers the bind mount only.)
```

Run: `./test.sh`
Expected: All phases pass including the updated 6c.

- [ ] **Step 10: Commit**

```bash
git add lib/plugins.mjs lib/plugins.test.mjs moat.mjs test.sh
git commit -m "feat: rewrite installed_plugins.json for in-container paths"
```

---

## Task 6: Doctor check (small convenience)

**Files:**
- Modify: `lib/doctor.mjs` (after the existing `ANTHROPIC_API_KEY` check around line 105–109)

- [ ] **Step 1: Add info-level plugin check**

Edit `lib/doctor.mjs`. After the `ANTHROPIC_API_KEY` block (lines 104–109), add:

```javascript
  // Host plugins dir
  const hostPlugins = join(process.env.HOME, '.claude', 'plugins');
  if (existsSync(hostPlugins)) {
    let count = 0;
    try {
      const { readdirSync } = await import('node:fs');
      count = readdirSync(join(hostPlugins, 'cache'), { withFileTypes: true })
        .filter(e => e.isDirectory()).length;
    } catch {}
    if (count > 0) {
      pass(`Host plugins dir present (~/.claude/plugins, ${count} marketplace${count === 1 ? '' : 's'})`);
    } else {
      info('Host plugins dir present but empty — no plugins will be mounted');
    }
  } else {
    info('Host plugins dir not found (~/.claude/plugins) — no plugins will be mounted');
  }
```

Note: the `count` variable counts subdirs under `cache/` which corresponds to marketplaces; it's a rough health signal, not a precise plugin count. That's fine for doctor output.

- [ ] **Step 2: Run doctor**

Run: `./moat.mjs doctor`
Expected: output includes one of the three plugin lines above. Exit code 0 (or whatever it was before — this check never fails).

- [ ] **Step 3: Run the test suite**

Run: `./test.sh`
Expected: Phase 1 (doctor) still passes.

- [ ] **Step 4: Commit**

```bash
git add lib/doctor.mjs
git commit -m "feat: surface host plugins dir status in doctor"
```

---

## Verification (end-to-end)

After all tasks:

- [ ] `node --test lib/plugins.test.mjs` passes.
- [ ] `./test.sh` exits 0 with no regressions.
- [ ] Real `moat` session against a scratch workspace: inside the container, `/home/node/.claude/plugins/cache/claude-plugins-official/superpowers/` is populated AND superpowers skills are available to the in-container Claude Code.
- [ ] `moat doctor` reports plugin status.
- [ ] Git log shows 4–6 focused commits on the branch.

## Out of scope

- Squid allowlist additions for plugins that make network requests — deferred to user via `.moat.yml` as each plugin is added.
- Sync of plugin-enablement state from host's per-project `settings.json` — container's settings.json is managed independently.
- Writable mount (so in-container `/plugin install` affects host) — explicitly rejected during brainstorming.
- Image rebuild on host plugin changes — by design, not needed with bind mount.
