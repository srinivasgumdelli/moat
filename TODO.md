# Short-term Improvements

## 1. Add `.dockerignore`

Exclude files that don't need to be in the Docker build context:
- `docs/`, `README.md`, `CLAUDE.md`, `TODO.md`, `.git/`, `setup.sh`, `*.md`

Only files needed in the build context: `Dockerfile`, `*.sh` (wrapper scripts, verify.sh), `tool-proxy.mjs`, `.proxy-token`

## 2. Support `anvil <path>` for targeting a specific repo

Currently `anvil.sh` hardcodes `WORKSPACE="$HOME/Repos"` and mounts the entire `~/Repos` directory. The tool proxy also receives `--workspace "$WORKSPACE"`.

Changes needed:
- `anvil.sh`: Accept optional first arg as workspace path, default to `~/Repos`
- `docker-compose.yml`: The `~/Repos:/workspace:cached` volume mount is hardcoded — need to pass it dynamically. Options: generate a temp compose override, or use env var substitution in compose (`${WORKSPACE:-~/Repos}:/workspace:cached`)
- `tool-proxy.mjs`: Already receives `--workspace` flag, so it just needs the right value passed
- Shell aliases in `~/.zshrc`: `anvil` stays as-is (default), usage becomes `anvil ~/Projects/myapp`
- `devcontainer up` and `devcontainer exec` both use `--workspace-folder` which should match

Key consideration: `devcontainer up --workspace-folder` controls what gets mounted AND the container identity. Changing it means a different container instance.

## 3. Pin Claude Code version

Currently `Dockerfile` uses `ARG CLAUDE_CODE_VERSION=latest` and `docker-compose.yml` passes `CLAUDE_CODE_VERSION: ${CLAUDE_CODE_VERSION:-latest}`.

Change: Pin to a specific version (check current with `npm view @anthropic-ai/claude-code version`). Keep the env var override so `CLAUDE_CODE_VERSION=1.2.3 anvil` still works.

## 4. Add `anvil update` subcommand

Quick way to rebuild the image (picks up new claude-code version, updated configs).

Changes to `anvil.sh`:
- If first arg is `update`: run `docker compose build --no-cache` against the config dir, then exit
- Could also support `anvil update --version 1.2.3` to pin a specific version

## Current file layout

```
anvil/
├── anvil.sh                    # Launcher
├── setup.sh                    # One-command install
├── tool-proxy.mjs              # Host-side proxy server
├── Dockerfile                  # Container image (node:22 base)
├── docker-compose.yml          # squid + devcontainer
├── devcontainer.json           # devcontainer CLI config
├── squid.conf                  # Domain whitelist
├── verify.sh                   # Post-start verification
├── {git,gh,terraform,kubectl,aws}-proxy-wrapper.sh
├── CLAUDE.md                   # Repo instructions (always commit+push)
├── README.md
└── docs/                       # setup.md, project-plan.md, architecture.md, ideas.md
```

## Key context
- Base image: `node:22` (native arm64), user is `node`
- Config installed to `~/.devcontainers/anvil/` by `setup.sh`
- `anvil.sh` starts tool proxy on host, then `devcontainer up`, then `devcontainer exec claude`
- Docker compose project name: `anvil`
