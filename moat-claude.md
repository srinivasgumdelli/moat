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

## Quality Gates

These are mandatory before pushing code:

1. **Run tests** — `run_tests` must pass. Never push with failing tests. Never say "I'll leave testing to you."
2. **Run diagnostics** — `run_diagnostics` to catch type errors and lint issues before committing, not just the auto-linter.
3. **Verify the build** — if the project has a build step (tsc, next build, go build, etc.), run it before calling a task done.

Do not skip quality gates. If tests or diagnostics fail, fix the issues before proceeding.

## Safety Rules

- **Never commit secrets** — before staging files, check for `.env` files, API keys, tokens, passwords, and credentials. If a file might contain secrets, do not stage it. If unsure, ask.
- **No hardcoded credentials or URLs** — use environment variables for anything that varies by environment (API endpoints, database URLs, keys, tokens). Never inline them in source code.
- **Read before edit** — always read a file before modifying it. Never guess at file contents or make blind edits.
- **Don't delete files without confirming intent** — especially config files, migrations, lock files, and anything that looks like it could be someone's in-progress work.

## Git Workflow

- Always commit and push changes without asking.
- Always use feature branches — never push directly to main.
- Open a PR for all changes, even small fixes.
- Use smaller, logically grouped commits.

## Session Discipline

- **Always push before ending a session** — work is not done until `git push` succeeds and `git status` shows a clean working tree. Never say "ready to push when you are" — just push.
- **File issues for incomplete work** — if you cannot finish everything, create beads tasks (`bd add`) for what remains so the next session picks it up.
- **Never leave uncommitted changes** — every session must end with a clean working tree. Commit or stash everything.

## Dependency Hygiene

- **Don't add dependencies without justification** — explain why a new package is needed. Prefer the standard library or existing dependencies over adding new ones.
- **Don't upgrade or downgrade dependencies unless asked** — a bug fix does not need a package version bump. Only change dependency versions when explicitly requested.

## PR Discipline

- **Keep PRs focused** — one logical change per PR. Do not bundle unrelated fixes or refactors into the same PR.
- **Always include a test plan in PR descriptions** — describe what to verify and how, not just what changed.

## IDE Tools

- Auto-diagnostics run after every Edit/Write (eslint for TS/JS, ruff for Python, go vet for Go).
- Use `run_diagnostics` for full type-checking (tsc, pyright, golangci-lint).
- Use `run_tests` for structured test output instead of raw CLI.
- Use `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_symbols` for code intelligence.
- Language servers start lazily — first LSP call for a language may take a few seconds.
