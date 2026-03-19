# Bug: Stale MCP Configs Persisting Across Runs

**Branch:** `fix/stale-mcp-configs`
**PR:** https://github.com/srinivasgumdelli/moat/pull/16
**Status:** 3 root causes identified and patched, but stale configs still persist in testing.

## Problem

When a user configures MCP servers on their host, runs Moat, then later removes or changes those servers and runs Moat again, the old MCP configs persist inside the container. Claude Code sees stale/phantom MCP servers that no longer exist on the host.

## Root Causes (3 issues, all fixed)

### 1. jq recursive merge only adds, never removes (FIXED — `0b707a4`)

**File:** `lib/mcp-servers.mjs`, `copyMcpServers()`

The old code used jq's `*` operator (recursive merge) to write MCP configs into the container's `/home/node/.claude/settings.json`:

```javascript
const jqExpr = `. * ${JSON.stringify({ mcpServers: filtered })}`;
```

This merges keys in but never deletes keys that are no longer present. A server forwarded on run N stays in settings.json on run N+1 even if removed from host config.

**Fix:** Replace with a set operation that keeps only built-in servers (`ide-tools`, `ide-lsp`) and overwrites everything else with the current forwarded set:

```javascript
const builtinTest = [...BUILTIN_SERVERS].map(k => `.key == ${JSON.stringify(k)}`).join(' or ');
const mergeObj = JSON.stringify(filtered);
const jqExpr = `.mcpServers = ((.mcpServers // {} | to_entries | map(select(${builtinTest})) | from_entries) + ${mergeObj})`;
```

### 2. `mcp-servers.json` not written when empty (FIXED — `0b707a4`)

**File:** `moat.mjs`, lines 158-164

The tool-proxy config file (`~/.moat/data/mcp-servers.json`) was only written when there were HTTP MCP servers to proxy. If all HTTP MCPs were removed, the old file persisted and the proxy kept serving stale endpoints.

**Fix:** Always write the file, even when empty (`{}`), to clear stale proxy configs.

### 3. Early return prevents cleanup when host has zero MCP servers (FIXED — `5b946a5`)

**File:** `lib/mcp-servers.mjs`

There were TWO early returns that prevented cleanup:

```javascript
// Early return #1 (line 151) — skips when host has no MCP servers
if (!mcpServers || Object.keys(mcpServers).length === 0) return;

// Early return #2 (line 188) — skips when all servers are filtered out
if (Object.keys(filtered).length === 0) return;
```

When `readHostMcpServers()` returns `{}` (user removed all MCP configs), the first early return fires before the jq cleanup logic runs. Similarly, if all servers are stdio with unknown commands, the second early return fires.

**Fix:** Remove both early returns. Default `mcpServers` to `{}` and let the jq cleanup always execute.

## Investigation Results

### What was verified

1. **jq expression is correct** — tested directly in the container:
   ```bash
   # Input: settings.json with ide-tools, ide-lsp, glean, datadog-mcp, slack
   # Expression: .mcpServers = ((keep builtins) + {})
   # Output: only ide-tools and ide-lsp remain
   ```
   The jq expression properly removes non-builtin servers and preserves builtins in all tested cases.

2. **`runCapture` properly propagates errors** — throws on non-zero exit code unless `allowFailure` is set. The `copyMcpServers` catch block would log any failure.

3. **No other code paths write to container settings.json** — only `copyMcpServers` and the Dockerfile's initial setup (build-time only).

4. **Container `.claude.json` has no MCP servers** — only `settings.json` has them.

5. **No project-level MCP configs** — `/home/node/.claude/projects/-workspace/` has no `settings.json` or `settings.local.json` with mcpServers.

6. **No workspace-level MCP configs** — `/workspace/.claude/settings.json` doesn't exist; `/workspace/.claude/settings.local.json` has no mcpServers.

### Current container state

As of latest inspection, the container's `settings.json` contains:

```json
{
  "mcpServers": {
    "ide-tools": { "command": "node", "args": ["/home/node/.claude/mcp/ide-tools.mjs"] },
    "ide-lsp": { "command": "node", "args": ["/home/node/.claude/mcp/ide-lsp.mjs"] },
    "glean_default": { "type": "http", "url": "https://paxos-be.glean.com/mcp/default" },
    "datadog-mcp": { "type": "http", "url": "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp" },
    "glean": { "type": "http", "url": "https://paxos-be.glean.com/mcp/default" }
  }
}
```

The 3 non-builtin servers (`glean_default`, `datadog-mcp`, `glean`) are all `type: "http"` without auth headers (OAuth-based). They go through the "not proxied" path in `copyMcpServers` and are forwarded directly with URL rewriting.

**Unknown:** Whether these servers are currently in the host config (legitimately forwarded on this run) or stale from a previous run. This cannot be determined from inside the container since `readHostMcpServers()` reads host-side files.

### Open questions

1. **Is the host-side moat installation running the fixed code?** — The fix is on branch `fix/stale-mcp-configs` in the workspace repo. If the moat binary on the host runs from a different location (e.g., a globally installed copy), it may still be running the old code.

2. **Are the 3 non-builtin servers actually stale?** — If they're still in the host's `~/.claude/settings.json` (or any of the 4 config sources), `readHostMcpServers()` would return them and `copyMcpServers` would legitimately write them.

3. **Is the docker exec jq command succeeding?** — On failure, `copyMcpServers` logs `"Failed to forward MCP servers into container: ..."`. Need to confirm whether this message appears in moat output.

## Potential issues not covered by the 3 fixes

### A. Global `moat-config` volume shared across workspaces

**File:** `docker-compose.yml:68-69`

```yaml
volumes:
  moat-config:
    name: moat-config
```

The `moat-config` volume has a fixed name (`name: moat-config`), meaning ALL moat sessions across ALL workspaces share the same `/home/node/.claude` directory. If two workspaces have different MCP server sets, `copyMcpServers` from one workspace overwrites the other's config.

**Impact:** Running moat for workspace B could remove workspace A's MCP servers. If workspace A's Claude Code session is still running, it would see settings change mid-session. This is a separate issue from stale configs but could cause confusion.

**Potential fix:** Use per-workspace volume names (e.g., `moat-config-${hash}`).

### B. Silent success when cleaning up (no log confirmation)

**File:** `lib/mcp-servers.mjs:212-215`

```javascript
const names = Object.keys(filtered);
if (names.length > 0) {
  log(`Forwarded ${names.length} MCP server${names.length === 1 ? '' : 's'} into container ...`);
}
```

When all MCP servers are removed (cleanup-only run), `filtered` is empty and **nothing is logged**. The user gets no confirmation that stale entries were cleaned up. This makes it hard to tell if the cleanup actually ran.

**Potential fix:** Log when cleanup runs with 0 forwarded servers:
```javascript
if (names.length > 0) {
  log(`Forwarded ${names.length} MCP server${names.length === 1 ? '' : 's'} into container ...`);
} else {
  log(`Cleaned up MCP servers in container (none to forward)`);
}
```

### C. Error message lacks detail on failure

**File:** `lib/mcp-servers.mjs:216-218`

```javascript
} catch (e) {
  log(`Failed to forward MCP servers into container: ${DIM}${e.message || e}${RESET}`);
}
```

All failures (docker exec connection, jq syntax error, file permissions, missing jq binary) produce the same generic message. User can't tell if the cleanup succeeded or failed.

**Potential fix:** Log the specific operation that failed, or include stderr in the error output.

### D. `readHostMcpServers` uses additive merge across config files

**File:** `lib/mcp-servers.mjs:57-81`

```javascript
const merged = {};
for (const src of sources) {
  const servers = readMcpFromFile(src);
  if (servers) {
    Object.assign(merged, servers);
  }
}
```

`Object.assign` only adds/overrides keys — it doesn't remove keys from earlier files. If a server is defined in `~/.claude.json` and also in `~/.claude/settings.json`, removing it from `settings.json` won't remove it from the merged result (it's still in `.claude.json`).

This matches Claude Code's own merge behavior so it's probably correct, but could confuse users who think removing from one file removes it everywhere.

### E. No test coverage

There are **no unit tests** for `mcp-servers.mjs`. The jq expression, shell escaping, filtering logic, and merge behavior are all untested. Given the complexity of the jq expression embedded in a shell command passed through `docker exec`, automated tests would catch regressions and edge cases (e.g., server names with special characters, empty configs, corrupted settings.json).

### F. `echo "$tmp"` could corrupt output

**File:** `lib/mcp-servers.mjs:203`

```javascript
`tmp=$(jq '${escaped}' /home/node/.claude/settings.json) && echo "$tmp" > /home/node/.claude/settings.json`
```

In some shells, `echo` interprets backslash escape sequences (`\n`, `\t`, `\\`). If settings.json contains values with backslashes, `echo` might mangle them. The container uses `node:22` (Debian-based), where `/bin/sh` is `dash` — `dash`'s `echo` does NOT interpret escapes by default, so this is likely safe. But using `printf '%s\n' "$tmp"` would be more robust.

### G. `readHostMcpServers` doesn't read project-level configs

**File:** `lib/mcp-servers.mjs:60-65`

Only reads from 4 global config paths:
1. `~/.claude.json`
2. `~/.claude/.claude.json`
3. `~/.claude/settings.json`
4. `~/.claude/settings.local.json`

Claude Code also reads MCP servers from project-level settings:
- `~/.claude/projects/<hash>/settings.json`
- `<workspace>/.claude/settings.json`
- `<workspace>/.claude/settings.local.json`

MCP servers configured at the project level on the host would NOT be forwarded into the container. This isn't a stale config issue but is a gap in the forwarding logic.

## MCP Forwarding Architecture

```
Host ~/.claude/settings.json (MCP servers)
  |
  v
readHostMcpServers()  [reads 4 config sources, filters built-ins]
  |
  +---> extractHttpMcpServers()  [external servers WITH explicit auth headers]
  |       |
  |       v
  |     moat.mjs writes ~/.moat/data/mcp-servers.json
  |       |
  |       v
  |     tool-proxy hot-reloads config on each request
  |       |
  |       v
  |     container settings.json: url -> http://host.docker.internal:9876/mcp/{name}
  |       |
  |       v
  |     Claude makes HTTP request -> proxy injects auth headers -> upstream
  |
  +---> extractMcpDomains()  [external hostnames -> squid whitelist]
  |
  +---> copyMcpServers()  [ALL servers -> container settings.json]
          |
          +-- HTTP (proxied): rewrite URL + inject proxy Bearer token
          +-- HTTP (not proxied): rewrite URL + strip auth headers
          +-- stdio: forward only if command in KNOWN_CONTAINER_COMMANDS
          |
          v
        docker exec jq -> /home/node/.claude/settings.json
        (preserves ide-tools, ide-lsp; replaces everything else)
```

## Key Files

| File | Role |
|------|------|
| `lib/mcp-servers.mjs` | Read host MCP configs, filter, rewrite, write into container |
| `moat.mjs` | Orchestrator — reads configs, writes proxy file, starts container, calls copyMcpServers |
| `tool-proxy.mjs` | HTTP reverse proxy on host; injects auth headers for proxied MCP servers |
| `squid.conf` | Outbound proxy in container; must whitelist MCP server domains |
| `docker-compose.yml` | Container definition; `moat-config` volume holds `/home/node/.claude` |
| `Dockerfile` | Image build — sets up initial settings.json with ide-tools, ide-lsp (line 136) |
| `lib/exec.mjs` | `runCapture` — spawns child processes, throws on non-zero exit |
| `lib/container.mjs` | Container lifecycle — find, start, teardown, exec Claude |

## Key Constants

- **BUILTIN_SERVERS:** `ide-tools`, `ide-lsp` — always preserved in container settings
- **KNOWN_CONTAINER_COMMANDS:** `node`, `npx`, `npm`, `python3`, `python`, `bash`, `sh`, `uvx`, `uv`, `pip`, `pip3`, `bunx`, `bun`, `deno` — stdio servers with other commands are skipped
- **Container settings path:** `/home/node/.claude/settings.json`
- **Proxy config path:** `~/.moat/data/mcp-servers.json`
- **Proxy token path:** `~/.moat/data/.proxy-token`

## Filtering Logic (who gets forwarded)

| Server Type | Has Auth Headers? | Localhost? | Result |
|---|---|---|---|
| HTTP/URL | Yes | No | Proxied through tool-proxy (auth stays on host) |
| HTTP/URL | Yes | Yes | Skipped from proxy; forwarded directly with localhost rewrite |
| HTTP/URL | No (OAuth) | No | Not proxied; forwarded directly (domain must be in squid whitelist) |
| HTTP/URL | No (OAuth) | Yes | Forwarded directly with localhost rewrite |
| stdio | N/A | N/A | Forwarded if command in KNOWN_CONTAINER_COMMANDS; skipped otherwise |

## Config sources (host-side read order)

`readHostMcpServers()` reads from 4 files, later wins on key conflicts:

1. `~/.claude.json`
2. `~/.claude/.claude.json`
3. `~/.claude/settings.json`
4. `~/.claude/settings.local.json`

**Not read:** project-level (`~/.claude/projects/<hash>/settings.json`) and workspace-level (`<workspace>/.claude/settings.json`) configs.

## Container config locations checked

| Path | Has mcpServers? |
|------|----------------|
| `/home/node/.claude/settings.json` | Yes — managed by `copyMcpServers` |
| `/home/node/.claude/.claude.json` | No — Claude Code runtime state only |
| `/home/node/.claude/projects/-workspace/settings.json` | Does not exist |
| `/home/node/.claude/projects/-workspace/settings.local.json` | Does not exist |
| `/workspace/.claude.json` | Does not exist |
| `/workspace/.claude/settings.json` | Does not exist |
| `/workspace/.claude/settings.local.json` | No mcpServers key |

## Testing

To verify the fix works:

1. **Add MCP servers to host config**, run `moat`, check container:
   ```bash
   docker exec <container> cat /home/node/.claude/settings.json | jq .mcpServers
   ```
2. **Remove MCP servers from host config**, run `moat` again, check container — stale entries should be gone.
3. **Check proxy config:**
   ```bash
   cat ~/.moat/data/mcp-servers.json
   # Should be {} when no HTTP MCPs with explicit headers exist
   ```
4. **Verify moat is running the fixed code** — confirm the moat binary on the host is from the `fix/stale-mcp-configs` branch.

## Remaining Considerations

- **KNOWN_CONTAINER_COMMANDS is a static allowlist.** Custom stdio commands (e.g. `go`, `ruby`) won't forward. This is by design but may surprise users.
- **Squid domain whitelist** — external MCP server domains must be whitelisted in `squid.conf` or `.moat.yml` `domains:` for direct (non-proxied) connections to work.
- **Docker named volume** (`moat-config`) persists across container recreations. The jq cleanup handles this, but if the volume is manually recreated it resets to clean state anyway.
- **Global volume sharing** — `moat-config` is shared across all workspaces. Running moat for different workspaces with different MCP servers will overwrite each other's config.
