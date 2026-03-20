# Next Steps

## Validate Node.js migration

- [ ] `moat doctor` — all checks pass
- [ ] `moat down` — tears down containers
- [ ] `moat` (normal launch) — proxy starts, container starts, Claude launches
- [ ] `moat plan` — Claude launches in read-only mode
- [ ] `moat` with `--add-dir` — extra directories mounted and registered
- [ ] `moat` on workspace with `package.json` containing `pg` — detects postgres, prompts to create `.moat.yml`
- [ ] `moat init` — scans deps, creates `.moat.yml` interactively
- [ ] Create `~/.claude/CLAUDE.md` on host, run `moat`, verify it appears inside container
- [ ] `moat update` — pulls latest, rebuilds image
- [ ] `moat attach-dir` / `moat detach-dir` — still work with Node.js entry point
- [ ] Run `test.sh` — all phases pass

## Validate install/update flow

- [ ] Fresh `install.sh` on machine with Docker+Node → clones repo, creates symlink, builds image, launches
- [ ] Fresh `./install.sh` from repo clone → same result (with prereq installs)
- [ ] `moat update` → pulls latest, rebuilds image
- [ ] `moat` → tool proxy finds token via `MOAT_TOKEN_FILE`, Docker build has token, session works
- [ ] Old user with `~/.devcontainers/moat/` directory → migrated to symlink, token preserved in `~/.moat/data/`
- [ ] `git status` in repo after all operations → clean (no token file committed)

## Validate IDE features

- [ ] `docker compose build` succeeds (Python, Go, linters, language servers all install)
- [ ] Edit a `.py` file with a lint error → ruff diagnostics appear in context
- [ ] Edit a `.ts` file in a project with eslint → eslint output appears
- [ ] Edit a `.go` file → `go vet` output appears
- [ ] `run_diagnostics` on a TS project → tsc errors returned
- [ ] `run_tests` on a project with tests → structured pass/fail output
- [ ] `lsp_hover` on a TS function → type signature returned
- [ ] `lsp_definition` on an import → source file and line returned

## Validate attach-dir/detach-dir

- [ ] `moat attach-dir ~/some-dir` with mutagen installed → live-sync to `/extra/<dir>`, no restart
- [ ] `moat attach-dir ~/some-dir` without mutagen → confirmation prompt, restart fallback, resume hint
- [ ] `moat detach-dir some-dir` → terminates sync session
- [ ] `moat detach-dir --all` → terminates all sync sessions
- [ ] `moat down` → cleans up mutagen sessions before tearing down containers
- [ ] Exit (Ctrl-C / Claude exit) → cleans up mutagen sessions
- [ ] `moat doctor` with mutagen installed → shows mutagen status and active session count
- [ ] Re-run `moat` with different `--add-dir` flags → recreates container (not silently reused)
- [ ] Re-run `moat` with same `--add-dir` flags → reuses container

## Future work

1. **Web preview / screenshots** — Playwright MCP for frontend work.
2. **Debugging tools** — Print debugging on steroids, snapshot debugging, etc.
3. **Project indexing** — ctags, dependency graphs, architecture summaries for large codebases.

See `docs/ideas.md` for full details.
