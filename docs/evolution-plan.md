# Moat — Evolution Plan: From Claude Sandbox to Generic Agent Orchestration

This plan addresses the gaps identified in [vibe-coding-alignment.md](vibe-coding-alignment.md) and charts a path to evolve Moat from a Claude Code–focused sandbox to a runtime-agnostic agent orchestration platform.

---

## Design Principles

1. **Runtime-agnostic core, runtime-specific adapters** — The safety, recovery, and observability layers work identically for every runtime. Runtime-specific features (hooks, MCP, instructions) are opt-in adapters.
2. **Enforce, don't advise** — Quality gates and cost limits are mechanical, not trust-based.
3. **Sessions have memory** — Each session produces artifacts (decisions, summaries, learnings) that persist and compound.
4. **Measure everything** — If Moat can't tell you whether it's helping, it's not done.

---

## Phase 1: Recovery & Checkpointing

**Goal**: No work is ever lost. Every session is recoverable.

### 1a. Auto-checkpoint on risky operations

Before any operation that modifies significant state, Moat auto-commits a checkpoint.

**Implementation**:
- Add a `checkpoint` endpoint to `tool-proxy.mjs`
- The git proxy wrapper detects destructive git operations (`reset`, `checkout .`, `clean`, `branch -D`) and triggers a checkpoint commit before executing
- Checkpoint commits use a distinctive prefix: `[moat-checkpoint] auto-save before {operation}`
- Checkpoints are local-only (not pushed) and can be garbage-collected after the session

**Files**: `tool-proxy.mjs`, `git-proxy-wrapper.sh`

### 1b. Session snapshots

Each session's workspace state is captured at start and end.

**Implementation**:
- On `session.start`: record the current HEAD SHA in audit log
- On `session.end`: auto-commit any uncommitted changes as `[moat-checkpoint] session end`
- Add `moat rewind <session-id|timestamp>` command that:
  1. Lists checkpoint commits from audit log
  2. Creates a new branch from the selected checkpoint
  3. Lets the developer review before merging back

**Files**: `moat.mjs` (session lifecycle), `lib/rewind.mjs` (new), `lib/audit.mjs`

### 1c. Undo last agent action

**Implementation**:
- Track the HEAD SHA before each agent spawns (already in audit log via `agent.spawn` event)
- `moat undo <agent-id>` reverts to the SHA before that agent started (agents are read-only today, so this is future-proofing for when agents gain write access)

**Files**: `lib/rewind.mjs`, `tool-proxy.mjs` (record pre-agent SHA)

---

## Phase 2: Quality Gate Enforcement

**Goal**: Broken code cannot be pushed. Quality controls scale with generation speed.

### 2a. Pre-push quality gate

A pre-push git hook that runs inside the container, triggered by the git proxy wrapper.

**Implementation**:
- When `git push` is proxied, tool-proxy runs a quality check sequence first:
  1. `run_diagnostics` equivalent (tsc/pyright/golangci-lint based on detected language)
  2. `run_tests` equivalent (vitest/pytest/go test)
  3. If either fails → block the push, return structured error with failures
- Gate is **on by default**, configurable via `.moat.yml`:
  ```yaml
  quality_gates:
    pre_push:
      diagnostics: true    # type-check before push
      tests: true          # run tests before push
      build: false         # optional: run build step
  ```
- Override: `MOAT_SKIP_GATES=1` env var for emergencies (logged in audit)

**Files**: `tool-proxy.mjs` (git push interception), `lib/quality-gates.mjs` (new), `.moat.yml` schema

### 2b. Post-install vulnerability scan

After any `npm install` / `pip install` detected in proxied commands, run a vulnerability scan.

**Implementation**:
- Detect package install commands in bash output or tool-proxy flow
- Run `npm audit --json` / `pip audit --json` after install completes
- Report findings as warnings (default) or blocking errors (`MOAT_AUDIT_BLOCK=1`)
- Results logged in audit trail

**Files**: `tool-proxy.mjs`, `lib/supply-chain.mjs` (new)

---

## Phase 3: Session Memory (Middle Loop)

**Goal**: Sessions compound. Knowledge persists and improves over time.

### 3a. Session summaries

At session end, generate and persist a structured summary.

**Implementation**:
- On `session.end`, aggregate audit events into a summary:
  - Files changed (from git diff)
  - Tools used (from audit log)
  - Tasks completed (from Beads)
  - Agents spawned and their outcomes
  - Duration, cost (from statusline data)
- Write to `~/.moat/data/workspaces/<hash>/sessions/<timestamp>.json`
- `moat history` command lists past sessions with summaries

**Files**: `moat.mjs`, `lib/session-summary.mjs` (new), `lib/history.mjs` (new)

### 3b. Decision log

Capture architectural decisions and rationale across sessions.

**Implementation**:
- Provide a `moat decision "description"` command (or in-container `decision` command)
- Decisions stored in `.moat/decisions/` within the workspace (committed to git)
- Loaded into context at session start (appended to instruction file)
- Each decision has: timestamp, session ID, description, files affected

**Files**: `lib/decisions.mjs` (new), decision CLI wrapper script

### 3c. Project knowledge base

Persistent, per-project knowledge that loads into every session.

**Implementation**:
- `.moat/knowledge.md` in workspace root — manually curated project knowledge
- Auto-appended to instruction file at session start (like CLAUDE.md merge)
- `moat learn "lesson"` appends to knowledge base
- Knowledge base is version-controlled (committed to git)

**Files**: `lib/instructions.mjs` (extend merge logic), `lib/knowledge.mjs` (new)

---

## Phase 4: Cost Guardrails

**Goal**: Developers can experiment freely within known bounds.

### 4a. Budget enforcement

**Implementation**:
- New config in `.moat.yml`:
  ```yaml
  budget:
    session_limit: 25.00    # USD per session
    warning_at: 0.80        # warn at 80% of limit
  ```
- Also configurable via env: `MOAT_COST_LIMIT=25`
- Status line hook checks cost against limit on each refresh
- At warning threshold: inject a warning into the agent's context ("Approaching budget limit")
- At limit: signal the runtime to pause (runtime-specific mechanism)
- Cost data logged in session summary

**Files**: `statusline.sh`, `lib/budget.mjs` (new), `.moat.yml` schema

### 4b. Per-session cost summary

**Implementation**:
- On `session.end`, write cost breakdown to session summary:
  - Total cost
  - Agent costs (per agent)
  - Duration
- `moat stats` aggregates across sessions: total spend, average session cost, cost trends

**Files**: `lib/session-summary.mjs`, `lib/stats.mjs` (new)

---

## Phase 5: Observability

**Goal**: If you can't measure it, you can't improve it.

### 5a. `moat stats` command

Aggregates audit data into actionable metrics.

**Implementation**:
- Reads `audit.jsonl` and session summaries
- Outputs:
  - Sessions: count, average duration, total cost
  - Tools: call counts, failure rates, blocked operations
  - Agents: spawn count, completion rate, average duration
  - Quality: gate failures, secrets detected, vulnerabilities found
- Supports `--json` for machine-readable output
- Supports time ranges: `moat stats --since 7d`

**Files**: `lib/stats.mjs` (new)

### 5b. Agent outcome tracking

**Implementation**:
- Extend `agent.done` audit event with:
  - Exit code (success/failure)
  - Output length (tokens/characters)
  - Duration
- `moat stats agents` shows agent success rates and patterns
- `agent results` includes success/failure classification

**Files**: `tool-proxy.mjs` (extend agent done event), `lib/stats.mjs`

---

## Phase 6: Generic Agent Orchestration

**Goal**: Moat works equally well with any coding agent runtime.

This is the architectural evolution from "Claude sandbox" to "agent orchestration platform." The existing runtime abstraction (`lib/runtimes/`) provides the foundation — this phase fills the gaps.

### 6a. Runtime capability matrix

Not all runtimes support the same features. Make this explicit.

**Implementation**:
- Extend the runtime config interface with a `capabilities` object:
  ```javascript
  export default {
    name: 'codex',
    // ... existing fields ...
    capabilities: {
      hooks: false,          // supports PostToolUse / StatusLine hooks
      mcp: false,            // supports MCP servers
      instructions: true,    // supports instruction files
      prompt: false,         // supports -p / --prompt flag
      allowedTools: false,   // supports tool restriction
      addDir: false,         // supports --add-dir
      configDir: false,      // has a config directory
    },
  };
  ```
- Moat checks capabilities before attempting to configure features
- `moat doctor` reports which features are available for the current runtime

**Files**: `lib/runtimes/*.mjs`, `lib/doctor.mjs`

### 6b. Instruction file support for all runtimes

Every runtime should get the planning-first workflow instructions.

**Implementation**:
- Set `instructionsFile` for all runtimes:
  - Claude: `CLAUDE.md` (existing)
  - Codex: `AGENTS.md` (Codex convention)
  - OpenCode: `AGENTS.md`
  - Amp: `AGENTS.md`
- Generate runtime-appropriate instruction content:
  - Strip Claude-specific references (MCP tools, Claude hooks)
  - Keep universal content (planning workflow, quality gates, safety rules, git workflow)
  - Add runtime-specific tips
- Template engine: `lib/instructions.mjs` renders from `moat-base.md` + runtime overlay

**Files**: `moat-base.md` (new — runtime-agnostic base), `lib/instructions.mjs`, `lib/runtimes/*.mjs`

### 6c. Generic hook system

Replace Claude-specific hooks with a runtime-agnostic event system.

**Implementation**:
- Define a hook protocol based on HTTP (like tool-proxy already uses):
  - `POST /hook/post-edit` — called after file edits (triggers auto-diagnostics)
  - `POST /hook/status` — called periodically (returns status line data)
  - `POST /hook/pre-push` — called before git push (quality gates)
- Runtimes that support hooks (Claude) use their native hook system to call these endpoints
- Runtimes without hooks get a polling-based fallback:
  - A watcher process monitors file changes and calls the diagnostics endpoint
  - Status is available via `moat status` command instead of inline display
- Hook implementations move from shell scripts to tool-proxy endpoints

**Files**: `tool-proxy.mjs` (new hook endpoints), `lib/hooks.mjs` (generalize), `auto-diagnostics.sh` (keep for Claude, add HTTP fallback)

### 6d. Generic IDE tools

Make diagnostics, testing, and LSP available beyond MCP.

**Implementation**:
- IDE tools (`run_diagnostics`, `run_tests`, `lsp_*`) are already Node.js scripts
- Expose them via tool-proxy HTTP endpoints:
  - `POST /ide/diagnostics` — run type-checker
  - `POST /ide/tests` — run test suite
  - `POST /ide/hover` — LSP hover info
  - `POST /ide/definition` — go-to-definition
- For Claude: MCP servers remain (they call the same underlying functions)
- For other runtimes: in-container wrapper scripts call these endpoints
  - `run_diagnostics` → `curl POST /ide/diagnostics`
  - `run_tests` → `curl POST /ide/tests`
- Runtimes with MCP support use MCP; others use HTTP wrappers

**Files**: `tool-proxy.mjs` (IDE endpoints), `ide-tools.mjs` (extract core logic), `ide-lsp.mjs` (extract core logic), wrapper scripts for non-MCP runtimes

### 6e. Runtime-agnostic agent spawning

The agent system already works for all runtimes. Formalize it.

**Implementation**:
- `agent-entrypoint.sh` already dispatches on `MOAT_RUNTIME_BINARY` — this is correct
- Add validation: check that the API key env var is set before spawning
- Add runtime-specific tool restrictions:
  - Claude: `--allowedTools Read,Grep,Glob,Task,WebFetch,WebSearch`
  - Codex: `--full-auto` (no tool restriction mechanism)
  - OpenCode/Amp: runtime-specific equivalents
- Document per-runtime agent capabilities in `moat doctor`

**Files**: `tool-proxy.mjs` (validation), `agent-entrypoint.sh`, `lib/runtimes/*.mjs` (agent tool config)

### 6f. Pluggable runtime installation

Make it easy to add new runtimes without modifying Dockerfiles.

**Implementation**:
- Move runtime installation from Dockerfile conditionals to a generic script:
  ```bash
  # install-runtime.sh — called during Docker build
  # Reads RUNTIME and RUNTIME_VERSION build args
  # Sources the install command from a registry file
  ```
- Runtime registry file (`runtimes.json`) defines install commands:
  ```json
  {
    "claude": { "install": "curl -fsSL https://claude.ai/install.sh | bash -s {version}" },
    "codex": { "install": "npm install -g @openai/codex@{version}" },
    "aider": { "install": "pip install aider-chat=={version}" },
    "cursor-agent": { "install": "npm install -g @cursor/agent@{version}" }
  }
  ```
- Adding a new runtime = adding an entry to `runtimes.json` + a `lib/runtimes/<name>.mjs` config
- Dockerfile becomes: `RUN /tmp/install-runtime.sh $RUNTIME $RUNTIME_VERSION`

**Files**: `install-runtime.sh` (new), `runtimes.json` (new), `Dockerfile`, `Dockerfile.agent`

---

## Phase 7: Supply Chain Security

**Goal**: Whitelisted registries are trusted but verified.

### 7a. Post-install audit hook

**Implementation**:
- Detect package manager invocations in proxied bash output
- After `npm install` completes: run `npm audit --json --audit-level=high`
- After `pip install` completes: run `pip audit --json` (requires `pip-audit` pre-installed)
- Report results as warnings in agent context
- Optionally block on critical vulnerabilities (`MOAT_VULN_BLOCK=critical`)
- Results logged in audit trail

**Files**: `lib/supply-chain.mjs` (new), `Dockerfile` (install `pip-audit`)

### 7b. Dependency diff on push

**Implementation**:
- Pre-push gate compares `package-lock.json` / `requirements.txt` diff
- If new dependencies added: run audit on new packages only
- Report: package name, version, license, known vulnerabilities
- Warn on: GPL in proprietary projects, packages with < 100 weekly downloads, packages < 30 days old

**Files**: `lib/quality-gates.mjs` (extend), `lib/supply-chain.mjs`

---

## Phasing & Priority

| Phase | Priority | Effort | Dependencies |
|---|---|---|---|
| 1. Recovery & Checkpointing | **P0** | Medium | None |
| 2. Quality Gate Enforcement | **P0** | Medium | None |
| 3. Session Memory | **P1** | Medium | Phase 1 (session lifecycle) |
| 4. Cost Guardrails | **P1** | Small | None |
| 5. Observability | **P2** | Medium | Phase 3 (session summaries) |
| 6. Generic Agent Orchestration | **P1** | Large | None (incremental) |
| 7. Supply Chain Security | **P2** | Small | Phase 2 (quality gates) |

**Recommended order**: 1 → 2 → 6a/6b (capabilities + instructions) → 4 → 3 → 6c/6d (hooks + IDE) → 5 → 7 → 6e/6f (agents + plugins)

---

## Architecture After Evolution

```
                        ┌──────────────────────────────────────────────┐
                        │              Host (trusted)                  │
                        │                                              │
                        │  tool-proxy.mjs                              │
                        │  ├── /git, /gh, /terraform, /kubectl, /aws   │
                        │  ├── /agent/* (spawn, list, log, kill)       │
                        │  ├── /hook/* (post-edit, status, pre-push)   │  ← NEW
                        │  ├── /ide/* (diagnostics, tests, lsp)        │  ← NEW
                        │  ├── /checkpoint (auto-save)                 │  ← NEW
                        │  ├── /mcp/* (reverse proxy)                  │
                        │  ├── quality-gates (pre-push enforcement)    │  ← NEW
                        │  ├── supply-chain (post-install audit)       │  ← NEW
                        │  ├── budget (cost enforcement)               │  ← NEW
                        │  ├── audit (structured JSONL)                │
                        │  └── secrets (pattern scanning)              │
                        │                                              │
                        │  Cloud credentials, GitHub tokens            │
                        │  Session summaries, decision logs             │  ← NEW
                        │  Stats aggregation                           │  ← NEW
                        └──────────────┬───────────────────────────────┘
                                       │ HTTP :9876 (bearer token)
                        ┌──────────────┴───────────────────────────────┐
                        │         Sandbox (internal network)           │
                        │                                              │
                        │  ┌─────────────────────────────────────────┐ │
                        │  │  Devcontainer                           │ │
                        │  │  Runtime: claude | codex | amp | ...    │ │
                        │  │  Workspace: /workspace (read-write)     │ │
                        │  │  Instructions: runtime-appropriate      │ │  ← NEW
                        │  │  Hooks: native or HTTP fallback         │ │  ← NEW
                        │  │  IDE: MCP or HTTP wrappers              │ │  ← NEW
                        │  │  Knowledge: .moat/knowledge.md          │ │  ← NEW
                        │  └─────────────────────────────────────────┘ │
                        │                                              │
                        │  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
                        │  │ Agent 1  │ │ Agent 2  │ │ Agent N  │    │
                        │  │ (any rt) │ │ (any rt) │ │ (any rt) │    │
                        │  │ ws: :ro  │ │ ws: :ro  │ │ ws: :ro  │    │
                        │  └──────────┘ └──────────┘ └──────────┘    │
                        │                                              │
                        │  Squid (domain whitelist)                    │
                        └──────────────────────────────────────────────┘
```

---

## What Changes for Each Runtime

| Feature | Claude (today) | All runtimes (after) |
|---|---|---|
| Security (network, creds, IaC) | Works | Works (no change) |
| Instructions | CLAUDE.md merge | Runtime-appropriate file from shared base |
| Auto-diagnostics | PostToolUse hook | Native hook OR HTTP fallback |
| Status line | StatusLine hook | Native hook OR `moat status` |
| IDE tools | MCP servers | MCP OR HTTP wrappers |
| Quality gates | Trust-based | Pre-push enforcement via tool-proxy |
| Recovery | None | Auto-checkpoint + `moat rewind` |
| Session memory | None | Session summaries + knowledge base |
| Cost control | Display only | Budget enforcement |
| Observability | Audit log only | `moat stats` + agent tracking |
| Supply chain | Domain whitelist | Domain whitelist + package audit |

---

## New `.moat.yml` Schema (After Evolution)

```yaml
runtime: claude                # claude | codex | opencode | amp | <custom>

services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: moat

env:
  DATABASE_URL: postgres://postgres:moat@postgres:5432/dev

domains:
  - .crates.io

docker: true

# NEW — quality gates
quality_gates:
  pre_push:
    diagnostics: true          # run type-checker before push
    tests: true                # run test suite before push
    build: false               # run build step before push
  post_install:
    audit: warn                # warn | block | off

# NEW — budget
budget:
  session_limit: 25.00         # USD
  warning_at: 0.80             # percentage

# NEW — secrets (existing, extended)
secrets:
  mode: warn                   # warn | block
  patterns:
    - name: internal-token
      regex: "MYCO_[A-Za-z0-9]{32}"

# NEW — session memory
memory:
  session_summaries: true      # persist session summaries
  decision_log: true           # enable decision tracking
  knowledge_base: true         # load .moat/knowledge.md into context
```

---

## New Commands Summary

| Command | Description |
|---|---|
| `moat rewind [session\|timestamp]` | Recover from a bad session by branching from a checkpoint |
| `moat history` | List past sessions with summaries |
| `moat stats [--since 7d] [--json]` | Aggregate metrics across sessions |
| `moat learn "lesson"` | Append to project knowledge base |
| `moat decision "description"` | Record an architectural decision |

## New In-Container Commands

| Command | Description |
|---|---|
| `run_diagnostics` | Available for all runtimes (MCP or HTTP wrapper) |
| `run_tests` | Available for all runtimes (MCP or HTTP wrapper) |
| `decision "description"` | Record a decision (via tool-proxy) |
