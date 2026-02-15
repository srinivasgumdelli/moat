# Moat — Usage Guide

## Commands

### `moat` — Launch a sandboxed Claude Code session

```bash
moat [workspace] [--add-dir <path>...] [claude_args...]
```

Starts a sandboxed Claude Code session. Everything runs inside a Docker container with network isolation (squid proxy whitelist) and credential isolation (host-side tool proxy).

**Workspace**: The first argument, if it's a directory, becomes the workspace mounted at `/workspace` inside the container. Defaults to the current directory.

```bash
moat                          # workspace = cwd
moat ~/Projects/myapp         # workspace = ~/Projects/myapp
```

**Extra directories**: Mount additional directories with `--add-dir`. Each appears at `/extra/<dirname>` inside the container and is automatically registered with Claude Code via `--add-dir`.

```bash
moat --add-dir ~/Projects/shared-lib
moat ~/Projects/myapp --add-dir ~/lib-a --add-dir ~/lib-b
```

**Claude args**: Anything that isn't a workspace path or `--add-dir` flag is passed through to Claude Code.

```bash
moat ~/Projects/myapp --resume     # resume previous session
moat . --model sonnet              # pass model flag
```

### `moat plan` — Read-only mode

```bash
moat plan [workspace] [--add-dir <path>...] [claude_args...]
```

Launches Claude Code with only read-only tools enabled: `Read`, `Grep`, `Glob`, `Task`, `WebFetch`, `WebSearch`. Write, Edit, Bash, and all other mutating tools are blocked.

Use this for research and planning phases where you want Claude to analyze code without making changes.

```bash
moat plan                         # read-only, workspace = cwd
moat plan ~/Projects/myapp        # read-only on specific dir
```

### `moat attach <dir>` — Live-sync a directory into a running session

```bash
moat attach <directory>
```

Attaches an additional directory to a running moat session using [Mutagen](https://mutagen.io/) two-way file sync. The directory appears at `/extra/<dirname>` inside the container.

Unlike `--add-dir` (which requires a container restart), `moat attach` works while Claude is running. Files sync both ways in real-time.

```bash
moat attach ~/Projects/shared-lib     # syncs to /extra/shared-lib
moat attach ~/data/fixtures           # syncs to /extra/fixtures
```

After attaching, tell Claude about the new directory:

> "I have an additional directory at /extra/shared-lib"

**With mutagen** (`brew install mutagen-io/mutagen/mutagen`): files sync live in both directions, no restart needed.

**Without mutagen**: falls back to restarting the container with the directory as a bind mount. This ends the current Claude session — you'll be prompted for confirmation. Resume with `moat --resume` afterward.

### `moat detach` — Remove a live-synced directory

```bash
moat detach <dir|--all>
```

Stops syncing a previously attached directory. Accepts a path or just the basename.

```bash
moat detach shared-lib                # stop syncing shared-lib
moat detach ~/Projects/shared-lib     # same thing (basename is used)
moat detach --all                     # stop all moat sync sessions
```

Sync sessions are also cleaned up automatically when the moat session exits.

### `moat update` — Update and rebuild

```bash
moat update [--version <version>]
```

Pulls the latest code from the repo and rebuilds the Docker image with `--no-cache`.

```bash
moat update                       # pull latest + rebuild
moat update --version 1.2.3       # rebuild with specific Claude Code version
```

### `moat doctor` — Diagnose setup issues

```bash
moat doctor
```

Runs diagnostic checks and reports PASS/FAIL/WARN for each:

| Check | Type |
|-------|------|
| `~/.local/bin/moat` symlink correct | FAIL if missing |
| Proxy token exists in data dir | FAIL if missing |
| Proxy token synced to repo | WARN if missing |
| `docker` command available | FAIL if missing |
| `node` command available | FAIL if missing |
| `devcontainer` CLI available | FAIL if missing |
| Docker daemon responding | FAIL if not |
| Docker image built | WARN if not |
| Tool proxy on :9876 | INFO (only during sessions) |
| `ANTHROPIC_API_KEY` set | FAIL if not |
| `mutagen` installed | INFO (optional, for attach/detach) |

Exits with code 1 if any FAILs, 0 otherwise.

## Session lifecycle

When you run `moat`:

1. Any previous session is torn down (containers removed, proxy killed)
2. Tool proxy starts on the host at `127.0.0.1:9876`
3. `devcontainer up` starts squid (forward proxy) + devcontainer
4. `verify.sh` runs inside the container to validate the sandbox
5. Claude Code launches with `--dangerously-skip-permissions`
6. On exit (or Ctrl-C), the EXIT trap tears everything down

Containers are **reused** across sessions when the workspace and extra directories haven't changed. On exit, only the tool proxy is stopped — containers keep running for fast re-launch. Bash history and Claude config persist across sessions via Docker volumes. Any Mutagen sync sessions (from `moat attach`) are terminated on exit.

## What works inside the container

### Network access

Only whitelisted domains are reachable (via squid proxy). Default whitelist:

- GitHub (`.github.com`, `.githubusercontent.com`, `.githubassets.com`)
- npm (`.npmjs.org`)
- Anthropic (`.anthropic.com`)
- Claude (`.claude.ai`, `.claude.com`)
- Sentry (`.sentry.io`)
- Statsig (`.statsig.com`)
- VS Code marketplace
- Host tool proxy (`host.docker.internal`)

Everything else is blocked. Direct connections bypassing the proxy are blocked at the network level.

To add a domain, edit `squid.conf`:

```
acl allowed_domains dstdomain .example.com
```

Then re-run `moat` (rebuilds automatically).

### Git and GitHub

Git and `gh` commands inside the container are proxied to the host via wrapper scripts. Your host credentials (SSH keys, GitHub tokens) never enter the container.

- `git` commands under `/workspace` are proxied; outside `/workspace` they use the container's git directly
- All `gh` commands are proxied

### IaC tools

Terraform, kubectl, and AWS CLI are available inside the container but restricted to read-only operations:

| Tool | Allowed | Blocked |
|------|---------|---------|
| terraform | `init`, `plan`, `validate`, `fmt`, `show`, `output`, `graph`, `providers`, `version`, `workspace`, `state`, `console` | `apply`, `destroy`, `taint`, `import`, `refresh` |
| kubectl | `get`, `describe`, `logs`, `top`, `api-resources`, `cluster-info`, `version`, `diff`, `explain` | `apply`, `delete`, `create`, `patch`, `exec` |
| aws | `describe-*`, `list-*`, `get-*`, `sts get-caller-identity`, `s3 ls`, `s3 cp` | `create-*`, `delete-*`, `terminate-*`, `put-*`, `update-*`, `run-*` |

These restrictions are enforced server-side on the host tool proxy — the container cannot bypass them.

### IDE tools

Claude has access to two MCP servers inside the container:

**ide-tools** — diagnostics and testing:
- `run_diagnostics` — full type-check/lint (tsc, pyright, golangci-lint)
- `run_tests` — structured test output (vitest/jest, pytest, go test)
- `list_tests` — list available tests without running them
- `get_project_info` — detect language, framework, test runner, build system

**ide-lsp** — code intelligence via persistent language servers:
- `lsp_hover` — type info and docs at a position
- `lsp_definition` — go to definition
- `lsp_references` — find all references
- `lsp_diagnostics` — errors/warnings for a file
- `lsp_symbols` — list symbols in a file
- `lsp_workspace_symbols` — search symbols across the workspace

Language servers (typescript-language-server, pyright, gopls) start lazily on first use.

**Auto-diagnostics**: After every file edit, fast linters run automatically (eslint for JS/TS, ruff for Python, go vet for Go) and inject results into Claude's context.

## File layout

```
~/.local/bin/moat                → <repo>/moat.sh (launcher)
~/.devcontainers/moat/           → <repo> (symlink, used by devcontainer)
~/.moat/data/.proxy-token          (persistent bearer token)
```

The repo itself lives at `~/.moat` (curl install) or wherever you cloned it.

## Troubleshooting

**Claude can't reach a domain**: Add it to `squid.conf` and re-run `moat`.

**Docker daemon not running**: Launch Docker Desktop. `moat doctor` will tell you.

**Tool proxy unreachable**: Check `cat /tmp/moat-tool-proxy.log` on the host. Verify with `curl http://127.0.0.1:9876/health`.

**Stale session**: If containers are stuck, `moat` cleans up previous sessions automatically on start. You can also manually run `docker compose --project-name moat down`.

**npm install fails inside container**: Ensure `.npmjs.org` is in `squid.conf`.

**git clone fails for non-GitHub host**: Add that domain to `squid.conf`. Git is configured to use HTTPS (SSH can't traverse the HTTP proxy).
