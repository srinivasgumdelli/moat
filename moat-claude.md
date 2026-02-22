# Moat — Base Instructions

## Planning-First Workflow

Before writing any code, follow this sequence:

1. **Explore** — Read relevant files, search the codebase, understand the existing architecture.
2. **Plan** — Outline the approach: which files to change, what patterns to follow, edge cases to handle.
3. **Create tasks** — Break the plan into trackable beads tasks (`bd add "task description"`).
4. **Implement** — Work through tasks one at a time, marking each done (`bd set <id> done`).
5. **Verify** — Run tests (`run_tests`), diagnostics (`run_diagnostics`), and confirm the change works.

**Skip planning** for trivial changes (typos, single-line fixes, config tweaks) — just do them directly.

### Beads Task Tracking

Use `bd` (beads) for task tracking throughout the session:
- `bd init` — initialize `.beads/` if it doesn't exist
- `bd add "description"` — create a new task
- `bd set <id> doing` — mark task as in progress
- `bd set <id> done` — mark task as complete
- `bd list` — check current tasks and status

## Git Workflow

- Always commit and push changes without asking.
- Always use feature branches — never push directly to main.
- Open a PR for all changes, even small fixes.
- Use smaller, logically grouped commits.

## IDE Tools

- Auto-diagnostics run after every Edit/Write (eslint for TS/JS, ruff for Python, go vet for Go).
- Use `run_diagnostics` for full type-checking (tsc, pyright, golangci-lint).
- Use `run_tests` for structured test output instead of raw CLI.
- Use `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_symbols` for code intelligence.
- Language servers start lazily — first LSP call for a language may take a few seconds.
