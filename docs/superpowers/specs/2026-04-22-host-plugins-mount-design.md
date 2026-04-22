# Host plugins mount — design

**Date:** 2026-04-22

**Status:** Accepted

**Trigger:** "install superpowers for moat"

## Problem

Moat sandboxes Claude Code inside a devcontainer. The container has its own `$CLAUDE_CONFIG_DIR` (`/home/node/.claude`, backed by the `moat-config` named volume). Plugins the user installs on the host — including `superpowers` from the official marketplace — live at `~/.claude/plugins/` on the host and are not visible inside the container. In-container Claude Code therefore has no access to superpowers skills.

## Goal

Whatever plugins the user has installed on the host should be available inside every moat session, with zero additional install steps. The user picks the plugin set on the host (`/plugin install ...`), and moat containers inherit it.

## Non-goals

- Moat does not install any specific plugin (including superpowers).
- Moat does not provide a CLI to manage plugins — that stays on the host.
- No image rebuild when plugins change.
- No change to `install.sh` — plugin provisioning is runtime, not install-time.

## Approach

Read-only bind mount of the host's plugin directory as a sub-path of the existing `moat-config` named volume:

```yaml
# devcontainer service, docker-compose.yml
volumes:
  - ${MOAT_WORKSPACE:-~/Repos}:/workspace:cached
  - moat-bashhistory:/commandhistory
  - moat-config:/home/node/.claude
  - ${HOME}/.claude/plugins:/home/node/.claude/plugins:ro   # NEW
```

Docker supports nested mounts — the bind takes precedence within the named volume at that sub-path. Read-only prevents the container from corrupting host plugin state.

### Why mount instead of copy

Moat's existing pattern for host → container sync (`lib/skills.mjs`, `lib/memory.mjs`) uses `docker cp`. This choice deviates deliberately:

- **Always reflects host state.** If the user runs `/plugin update superpowers` on the host mid-session, it's live in-container. No re-sync.
- **No persistence drift.** `moat-config` is a named volume that survives container removal. If we copied plugins in, uninstalling on the host would leave stale copies in the volume. Bind mount has no such drift.
- **No copy cost.** Plugin dirs can be large (skills + node_modules for some plugins). Copying at every session start is wasteful.
- **User's explicit direction:** "mount from host always."

### Graceful degradation

If `~/.claude/plugins/` does not exist on the host, a static bind mount in `docker-compose.yml` would fail compose-up. Handle this via a generated override file, matching the existing pattern in `lib/compose.mjs` (`generateExtraDirsYaml`, `generateDockerYaml`):

- New module `lib/plugins.mjs` exports `generatePluginsYaml(hostPluginsDir)`.
- If `hostPluginsDir` exists and is non-empty, emit `docker-compose.plugins.yml` with the bind mount.
- Otherwise, emit a no-op override (`services: { devcontainer: {} }`) so `docker compose -f ... -f docker-compose.plugins.yml` always works.
- Wire it into the compose argument list in `moat.mjs` alongside `docker-compose.services.yml` etc.

The plugins override is generated at session start (same lifecycle as services/extra-dirs), not at install time.

### Path-rewrite escape hatch (verify first)

`~/.claude/plugins/installed_plugins.json` stores absolute `installPath` strings like `/Users/<user>/.claude/plugins/cache/...`. These paths won't exist inside the container.

Two possible behaviors for Claude Code's plugin loader:

1. **Scan-based:** enumerates `$CLAUDE_CONFIG_DIR/plugins/cache/<marketplace>/<plugin>/<version>/` at startup and reads `plugin.json` from each dir. `installed_plugins.json` is bookkeeping only. → Bind mount works as-is.
2. **Manifest-based:** uses `installPath` from `installed_plugins.json` literally. → `/Users/<user>/...` doesn't resolve in-container, plugins silently fail to load.

**Plan:** verify empirically during implementation (start a moat session with the bind mount, check whether `/superpowers:brainstorming` is available inside). Only if case 2, add a rewrite step: copy `installed_plugins.json` to a writable location, replace host `$HOME/.claude` prefix with `/home/node/.claude`, write to the container's plugins dir. This would require dropping the `:ro` flag or using a tmpfs overlay — defer the exact mechanism until we know whether it's needed (YAGNI).

## Scope boundaries

In scope:

- New `lib/plugins.mjs` module.
- Generated `docker-compose.plugins.yml` override.
- Compose argument wiring in `moat.mjs` (and wherever compose is currently invoked).
- Minimal doctor check: warn if `~/.claude/plugins/` is empty ("no plugins on host — nothing will be mounted").
- Test coverage in `test.sh` for the generated override + non-empty case.

Out of scope:

- Modifying `lib/skills.mjs` (non-plugin host skills at `~/.claude/skills/` continue to use the copy pattern).
- `install.sh` changes.
- Plugin-specific allowlist changes in squid/tool-proxy (plugins that phone out will need domains added separately via `.moat.yml`).
- Syncing `~/.claude/settings.json` plugin enablement state — if Claude Code stores enabled-plugin lists per project in `$CLAUDE_CONFIG_DIR/settings.json`, the container's copy already persists in the `moat-config` volume and is independent.

## Architecture

```
host                                 container
────                                 ─────────
~/.claude/plugins/    ──ro bind──>   /home/node/.claude/plugins/
  cache/<mkt>/<p>/                     cache/<mkt>/<p>/
  installed_plugins.json               installed_plugins.json
  marketplaces/                        marketplaces/
  ...                                  ...

~/.claude/        ── (not mounted) ── /home/node/.claude/ (moat-config volume)
  skills/         ──docker cp──────>  skills/
  commands/       ──docker cp──────>  commands/
  projects/.../   ──docker cp──────>  projects/-workspace/memory/
  settings.json   (stays on host)     settings.json (baked in Dockerfile)
```

## File changes

- **Add:** `lib/plugins.mjs` — one exported function, `generatePluginsYaml(hostPluginsDir)` returning the YAML string (same shape as `generateDockerYaml` / `generateExtraDirsYaml` in `lib/compose.mjs`). Caller writes it to disk.
- **Add:** generated file `docker-compose.plugins.yml` (written under the workspace data dir, like `docker-compose.services.yml`).
- **Modify:** `moat.mjs` — call `generatePluginsYaml` during the same phase that generates other override files; include the new file in the `docker compose -f ... -f ...` argument list.
- **Modify:** `lib/doctor.mjs` — optional friendly check.
- **Modify:** `test.sh` — cover the empty-host and non-empty-host cases.

No changes to `Dockerfile`, `install.sh`, `squid.conf`, `tool-proxy.mjs`.

## Testing

- `test.sh` end-to-end case: boot moat, verify `/home/node/.claude/plugins/` inside the container contains the same top-level entries as `~/.claude/plugins/` on the host.
- Empty-host case: temporarily point `HOME` at a tmpdir with no `.claude/plugins/`, ensure moat still boots (no-op override).
- Superpowers skill availability: inside the container, `ls /home/node/.claude/plugins/cache/claude-plugins-official/superpowers/` returns a populated dir.
- End-to-end skill invocation (manual, one-time): spawn Claude Code inside moat and confirm a superpowers skill is callable — this is the step that resolves the path-rewrite question.

## Rollout

Single PR. No migration needed for existing users — the `moat-config` volume is untouched, and the new bind mount simply adds a read-only view.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Claude Code uses absolute `installPath` from manifest | Medium | Empirical check, add rewrite step only if needed |
| Plugin needs network egress blocked by squid | Medium | User adds domains to `.moat.yml`; not moat's job to anticipate every plugin |
| Host plugin writes to a plugin-local cache | Low | `:ro` mount causes plugin to fail loudly rather than silently corrupt host state; user can remount if desired |
| Host and container on different OS/arch (plugin has native binaries) | Low | Superpowers and most known plugins are pure JS/markdown; document that native plugins may not work |
