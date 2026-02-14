# Headless IDE: Ideas

Turn the sandboxed devcontainer from "Claude Code in a box" into a full development environment that Claude can use autonomously — with the same tooling a human developer would have, minus the GUI.

## What's Missing Today

Claude currently has: file read/write, bash, git/gh (via proxy), and web search. That's roughly equivalent to SSH into a server with vim. A real IDE gives you:

- Code intelligence (go-to-definition, find references, type errors)
- Linting and formatting on save
- Debugging (breakpoints, step-through, inspect variables)
- Test runners with structured output
- Build system integration
- Dependency management
- Project-wide refactoring tools
- Background compilation / type checking

## Ideas

### 1. Language Servers (LSP)

The biggest bang for the buck. Install language servers in the container and expose them to Claude via an MCP server or wrapper tool.

- **TypeScript**: `typescript-language-server` — hover info, diagnostics, go-to-definition, rename symbol, auto-imports
- **Python**: `pyright` or `pylsp` — type checking, completions, diagnostics
- **Go**: `gopls`
- **Rust**: `rust-analyzer`

Implementation options:
- **MCP server that speaks LSP**: A bridge that starts language servers and exposes `textDocument/definition`, `textDocument/references`, `textDocument/diagnostic` etc. as MCP tools Claude can call
- **CLI wrapper**: Something like `lsp-query --lang ts --action references --file src/foo.ts --line 42` that starts the LS, sends the request, returns JSON, and exits (or keeps a persistent connection)
- **Just run the CLI directly**: Many LSPs have CLI modes — `tsc --noEmit` for type errors, `pyright --outputjson` for Python diagnostics. No bridge needed, just teach Claude to use them

Worth exploring: which approach gives Claude the most useful information with the least token overhead?

### 2. Pre-computed Diagnostics

Run linters/type checkers in the background and surface results proactively:

- `tsc --watch --noEmit` running in a tmux pane, output piped to a file Claude can read
- `eslint` / `ruff` / `clippy` output after each file save
- A "problems" file that aggregates all diagnostics, similar to VS Code's Problems panel

Could be a hook: after Claude writes a file, automatically run the relevant linter and inject the output.

### 3. Structured Test Runner

Claude currently runs `pytest` or `npm test` and parses stdout. A structured test runner would give:

- JSON output with pass/fail/skip per test, duration, error messages, stack traces
- Ability to run a single test by name
- Coverage data (which lines are covered, which aren't)
- Watch mode integration

Tools: `pytest --tb=short -q --json-report`, `vitest --reporter=json`, `go test -json`

### 4. Debugging

The hardest to make useful for an LLM, but potentially the most powerful for hard bugs:

- **Print debugging on steroids**: Automatically instrument functions with entry/exit logging, argument/return values. Something like `debug-trace src/auth.ts:login` that rewrites the function temporarily
- **Snapshot debugging**: Run tests with a time-travel debugger (`rr` for C/C++, `replay.io` for JS), let Claude query state at any point
- **Conditional breakpoints via script**: `node --inspect` + a script that connects, sets breakpoints, collects data, disconnects. Claude describes what to inspect, script does the mechanical work
- **Core dump analysis**: For crashes, generate a core dump and let Claude query it

Pragmatic starting point: a tool that runs a command with `NODE_DEBUG`, `PYTHONFAULTHANDLER`, or `RUST_BACKTRACE=full` and captures structured output.

### 5. Background Services / Docker Compose Dev Stack

For full-stack work, Claude needs to run databases, APIs, queues:

- Extend docker-compose.yml to optionally spin up postgres, redis, etc.
- Port forwarding from container to host (or just keep it all in the sandbox network)
- Health checks and service readiness
- Seed data / migrations on start

Challenge: resource limits. The current 4 CPU / 8GB might not be enough for a full stack. Make it configurable per project.

### 6. File Watcher + Auto-Actions

A daemon in the container that watches for file changes and runs configured actions:

```yaml
# .claude/watchers.yml
- pattern: "**/*.ts"
  on_save:
    - tsc --noEmit
    - eslint --fix {file}
- pattern: "**/*.test.ts"
  on_save:
    - vitest run {file}
```

Results written to a known location Claude can check, or surfaced as Claude Code hooks.

### 7. Project Context / Indexing

Help Claude understand large codebases faster:

- **ctags / TAGS file**: Generated on container start, updated on file changes. Claude can grep it for symbol locations
- **Dependency graph**: `madge` for JS, `pydeps` for Python — which modules depend on which
- **Architecture summary**: Auto-generated from directory structure, package.json, imports. Cached in `.claude/project-map.md`
- **Embeddings index**: Pre-compute embeddings for all source files, expose a "semantic search" tool. Heavier but powerful for large codebases

### 8. Terminal Multiplexer Integration

Give Claude multiple persistent terminal sessions:

- tmux or screen inside the container
- One pane for builds, one for tests, one for a dev server, one for Claude's commands
- Claude can check output from any pane without killing running processes
- Long-running commands don't block Claude's main session

Claude Code already has background tasks, but tmux would give named, persistent sessions that survive across tool calls.

### 9. Git Worktrees for Parallel Work

Let Claude work on multiple branches simultaneously:

- `git worktree add` for each task/branch
- Each worktree gets its own LSP instance
- Claude can switch between tasks without stashing
- Useful for: "fix this bug on main while continuing the feature on the branch"

### 10. Web Preview / Browser Automation

For frontend work, Claude needs to see what it's building:

- Headless Chrome/Playwright in the container
- Screenshot tool: `screenshot http://localhost:3000/dashboard` → returns an image Claude can analyze
- DOM inspection: `inspect-page http://localhost:3000 --selector ".sidebar"` → returns HTML/CSS/computed styles
- Accessibility audit: `axe-check http://localhost:3000` → returns a11y violations
- Visual regression: compare screenshots before/after changes

### 11. Secrets Management

Beyond the tool proxy, a proper secrets vault for the IDE:

- Project-specific secrets in an encrypted store (age, sops)
- Mounted as env vars only when needed (e.g., for running integration tests)
- Audit log of which secrets were accessed and when
- Rotation support

### 12. Per-Project Configuration

A `.claude/ide.yml` or similar that configures the IDE per project:

```yaml
language_servers:
  - typescript
  - python
services:
  - postgres:15
  - redis:7
env:
  DATABASE_URL: postgres://localhost/dev
test_command: npm test
build_command: npm run build
lint_command: npm run lint
allowed_domains:
  - .pypi.org
  - .crates.io
```

The container reads this on start and configures itself accordingly.

## Priority Order (suggested)

1. **Language servers via CLI** — highest value, moderate effort. Start with `tsc --noEmit` and `pyright`, no bridge needed
2. **Structured test output** — easy, just use `--json` flags that already exist
3. **File watcher + auto-lint** — medium effort, catches errors before Claude moves on
4. **Per-project config** — enables everything else to be project-specific
5. **Web preview / screenshots** — essential for frontend work
6. **Background services** — essential for full-stack work
7. **LSP MCP bridge** — the "real" solution for code intelligence, higher effort
8. **Terminal multiplexer** — quality of life, not urgent
9. **Debugging tools** — high value but hard to get right for LLMs
10. **Indexing / embeddings** — useful for large codebases, can defer

## Open Questions

- Should language servers run persistently or on-demand? Persistent is faster but uses memory
- How much of this should be in the container vs. on the host via the tool proxy?
- Should Claude be able to install its own tools, or is the set fixed per image?
- How do we handle projects that need specific runtime versions (node 18 vs 22, python 3.11 vs 3.12)?
- Is there a way to give Claude "IDE actions" without the token overhead of describing every LSP capability?
