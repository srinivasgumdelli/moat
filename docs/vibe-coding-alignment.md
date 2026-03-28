# Moat × Vibe Coding — Alignment & Gap Analysis

An analysis of how Moat aligns with the principles in *Vibe Coding: Building Production-Grade Software With GenAI, Chat, Agents, and Beyond* by Gene Kim, Steve Yegge, and Dario Amodei — and where the critical gaps are.

---

## Where Moat Aligns

### FAAFO — Fast, Ambitious, Autonomous, Fun, Optionality

The book argues developers should be able to work fast and autonomously with AI agents. Moat enables this by wrapping Claude Code in a fail-closed security perimeter (Docker internal network, squid domain whitelist, credential-proxying) so it can run with `--dangerously-skip-permissions` safely. The developer can issue ambitious, open-ended instructions and walk away — the agent has everything it needs, but can't exfiltrate data, mutate infrastructure, or leak credentials.

### Nygard Stability Criterion

*"When code generation speed increases by 100x, control mechanisms must also increase by at least 100x."*

Moat scales the security controls automatically:

| Control Layer | What It Catches |
|---|---|
| Network isolation (Docker internal + squid) | Data exfiltration, unauthorized API calls |
| IaC allowlists (terraform plan-only, kubectl read-only, aws read-only) | Destructive infrastructure commands |
| Credential isolation (tool-proxy on host) | Credential leakage into container |
| Secrets scanning (pre-commit + tool-proxy flow) | Leaked credentials in code or proxied commands |
| Audit logging (structured JSONL) | Full trail of every proxied command |
| Auto-diagnostics (PostToolUse hook) | Lint errors after every file edit |
| Read-only agent containers | Background agents can research but never mutate |

### Head Chef Mindset

*"The developer becomes the orchestrator — designing the menu, directing the team, ensuring quality."*

Moat provides the orchestration tooling:
- **Beads task tracking** — decompose work, track status, display in status line
- **Background agents** — spawn parallel research/test/verification agents
- **IDE tools** (MCP servers) — `run_diagnostics`, `run_tests`, LSP intelligence
- **Status line** — real-time dashboard (task, agent count, context %, cost)

### Task Decomposition

Beads is integrated directly into the container. Tasks persist across sessions and show in the status line.

### Agent Parallelism

Each agent runs in its own isolated container with workspace mounted read-only. Developers can spawn independent subtasks (testing, research, verification) while continuing primary work. Full lifecycle management via `agent list/log/kill/results/wait`.

---

## Critical Gaps

### 1. No Rollback or Recovery (Severity: Critical)

**Book principle**: Strategic checkpointing — commit 4x more frequently than traditional development to create recovery points.

**Current state**: Moat has zero recovery infrastructure.
- No automatic git commits before risky operations
- No `moat rollback` or `moat undo` command
- No session snapshots — if Claude goes off the rails, the only recourse is manual git history
- `moat down` destroys the container; uncommitted work is gone
- The CLAUDE.md says "always commit before ending a session" but that's trust-based, not enforced

**Risk**: The book explicitly warns about agents "nearly deleting weeks of work." Moat has no mechanical defense against this.

### 2. No Quality Gate Enforcement (Severity: High)

**Book principle**: *"The most critical discipline is that verification becomes non-negotiable"* and *"vibe code with the most rigorous DevOps, CI, code review, and testing practices imaginable."*

**Current state**: Moat has the tools but no gates.
- `run_tests`, `run_diagnostics`, auto-linting all exist
- But nothing prevents `git push` with failing tests
- No pre-push hook runs the test suite or type-checker
- No build verification before commit
- No code coverage requirements
- Secrets scanning is a pre-commit hook, but test/build/diagnostic gates are not

**Risk**: The Nygard Stability Criterion says controls must scale with generation speed. Moat scales the security controls but not the quality controls. A developer can push broken code and break CI/CD.

### 3. Missing the Middle Loop (Severity: High)

**Book principle**: The Three Developer Loops — Inner (seconds), Middle (hours–days), Outer (days–weeks). The middle loop requires *"memory systems, coordination protocols, and workflow automation."*

**Current state**: Moat is strong on the inner loop (auto-diagnostics, LSP) and parts of the outer loop (IaC guardrails), but the middle loop is absent.
- No session memory — every `moat` launch starts from zero context
- No decision logging — "why did Claude choose this architecture?" is lost
- No knowledge distillation — patterns learned in session A aren't available in session B
- No conversation recording for later review
- Status line shows context % used but there's no context management strategy

**Risk**: Each session reinvents the wheel. No compounding improvement over time. Large codebases exhaust context without help prioritizing what matters.

### 4. Cost Display Without Guardrails (Severity: Medium)

**Book principle**: FAAFO includes optionality — the freedom to experiment cheaply. Developers need visibility to make informed decisions.

**Current state**: The status line shows `$0.47` but there's no:
- Budget limit enforcement (`MOAT_COST_LIMIT=50`)
- Warning threshold ("approaching $25, pause?")
- Per-agent cost tracking or breakdown
- Multi-session cost aggregation

**Risk**: Runaway Claude sessions could cost $100+ without warning. Developers have no visibility into which operations are expensive.

### 5. Supply Chain Gap (Severity: Medium)

**Book principle**: The book warns about agents "creating dependencies developers didn't intend."

**Current state**: Moat whitelists `.npmjs.org` and `.pypi.org` but once a domain is allowed, everything on it is trusted.
- No package signature verification or checksum validation
- No known-vulnerability scanning (no `npm audit`, Snyk, Dependabot integration)
- No typosquatting detection
- No SBOM generation

**Risk**: `npm install malicious-package` works fine from inside the sandbox. Domain-level whitelisting doesn't protect against compromised registries.

### 6. No Observability or Feedback Loops (Severity: Medium)

**Book principle**: Feedback loops are foundational. "The disciplines of verification, fast feedback, decomposition, and checkpointing provide the control panel."

**Current state**: Audit logging exists (`audit.jsonl`) but there's no analysis layer.
- No session analytics (duration, tool calls, success rate)
- No agent outcome tracking (do agents actually complete their tasks?)
- No trend analysis across sessions
- No `moat stats` command
- No alerting on anomalous patterns
- No way to measure whether Moat is helping or slowing the developer down

**Risk**: Moat captures data but never closes the loop. No way to make data-driven decisions about AI tooling ROI.

### 7. Claude-Only IDE Features (Severity: Medium)

**Current state**: The runtime abstraction supports Claude, Codex, OpenCode, and Amp — but only Claude gets the full experience.

| Feature | Claude | Codex | OpenCode | Amp |
|---|---|---|---|---|
| Network isolation | yes | yes | yes | yes |
| IaC allowlists | yes | yes | yes | yes |
| Secrets scanning | yes | yes | yes | yes |
| Audit logging | yes | yes | yes | yes |
| Agent spawning | yes | yes | yes | yes |
| Auto-diagnostics hook | yes | **no** | **no** | **no** |
| Status line hook | yes | **no** | **no** | **no** |
| MCP servers (IDE tools, LSP) | yes | **no** | **no** | **no** |
| Planning instructions | yes | **no** | **no** | **no** |
| Beads integration | yes | **no** | **no** | **no** |

The security layer is generic but the developer experience layer is Claude-only.

---

## Summary

| Book Principle | Moat Status |
|---|---|
| Security isolation (FAAFO autonomy) | **Strong** |
| Inner loop feedback (diagnostics, LSP) | **Strong** |
| IaC safety (Nygard controls) | **Strong** |
| Agent parallelism (Head Chef) | **Strong** |
| Task decomposition (Beads) | **Good** |
| Checkpointing / recovery | **Missing** |
| Quality gate enforcement | **Missing** |
| Middle loop (memory, context) | **Missing** |
| Cost guardrails | **Weak** |
| Supply chain verification | **Weak** |
| Observability / feedback loops | **Weak** |
| Multi-runtime parity | **Weak** |

**Bottom line**: Moat nails the security moat — the castle walls are solid. What's missing is the internal governance: making sure the work happening *inside* the castle is recoverable, verifiable, and improving over time.
