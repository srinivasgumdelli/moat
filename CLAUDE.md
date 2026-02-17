# Moat — Claude Code Instructions

## Workflow
- Always commit and push changes without asking.
- Always use feature branches — never push directly to main.
- Open a PR for all changes, even small fixes.
- Use smaller, logically grouped commits.
- Use `bd` (beads) for task tracking. Run `bd init` if `.beads/` doesn't exist. Create tasks with `bd add`, update status with `bd set`, and check tasks with `bd list`.

## IDE Tools
- Auto-diagnostics run after every Edit/Write (eslint for TS/JS, ruff for Python, go vet for Go).
- Use `run_diagnostics` for full type-checking (tsc, pyright, golangci-lint).
- Use `run_tests` for structured test output instead of raw CLI.
- Use `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_symbols` for code intelligence.
- Language servers start lazily — first LSP call for a language may take a few seconds.
