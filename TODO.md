# Next Steps

## IDE Features (Phase 4)

Priority order from `docs/ideas.md`:

1. **Language server diagnostics via CLI** — Run `tsc --noEmit`, `pyright` as PostToolUse hooks after file edits. Highest value, no LSP bridge needed.
2. **Structured test output** — Use `--json` flags (`pytest --json-report`, `vitest --reporter=json`) for structured pass/fail results.
3. **File watcher + auto-lint** — PostToolUse hook on Edit/Write that runs linters and injects diagnostics.
4. **Per-project config** — `.claude/ide.yml` to configure language servers, services, and allowed domains per project.
5. **Web preview / screenshots** — Playwright MCP for frontend work.
6. **Background services** — Extend docker-compose for postgres, redis, etc.

See `docs/ideas.md` for full details and `docs/project-plan.md` Phase 4 for implementation notes.
