# Next Steps

## Validate install/update flow

- [ ] Fresh `install.sh` on machine with Docker+Node → clones repo, creates symlink, builds image, launches
- [ ] Fresh `./setup.sh` from repo clone → same result (with prereq installs)
- [ ] `moat update` → pulls latest, rebuilds image
- [ ] `moat` → tool proxy finds token via `MOAT_TOKEN_FILE`, Docker build has token, session works
- [ ] Old user with `~/.devcontainers/moat/` directory → migrated to symlink, token preserved in `~/.moat/data/`
- [ ] `git status` in repo after all operations → clean (no token file committed)

## Validate Phase 4 IDE features

- [ ] `docker compose build` succeeds (Python, Go, linters, language servers all install)
- [ ] Edit a `.py` file with a lint error → ruff diagnostics appear in context
- [ ] Edit a `.ts` file in a project with eslint → eslint output appears
- [ ] Edit a `.go` file → `go vet` output appears
- [ ] Edit a `.md` file → no diagnostics (expected)
- [ ] `run_diagnostics` on a TS project → tsc errors returned
- [ ] `run_tests` on a project with tests → structured pass/fail output
- [ ] `get_project_info` → detects language, framework, test runner
- [ ] `lsp_hover` on a TS function → type signature returned
- [ ] `lsp_definition` on an import → source file and line returned
- [ ] `lsp_references` on a function → call sites listed

## Future work

1. **Per-project config** — `.claude/ide.yml` to configure language servers, services, and allowed domains per project.
2. **Web preview / screenshots** — Playwright MCP for frontend work.
3. **Background services** — Extend docker-compose for postgres, redis, etc.
4. **Debugging tools** — Print debugging on steroids, snapshot debugging, etc.
5. **Project indexing** — ctags, dependency graphs, architecture summaries for large codebases.

See `docs/ideas.md` for full details.
