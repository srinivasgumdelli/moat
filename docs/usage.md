# Moat — Usage Guide

## Commands

### `moat` — Launch a sandboxed Claude Code session

```bash
moat [workspace] [--add-dir <path>...] [claude_args...]
```

Starts a sandboxed Claude Code session. Everything runs inside a Docker container with network isolation (squid proxy whitelist) and credential isolation (host-side tool proxy).

**Workspace**: The first argument, if it's a directory, becomes the workspace mounted at `/workspace` inside the container. Defaults to the current directory.

```bash
moat                          # workspace = cwd
moat ~/Projects/myapp         # workspace = ~/Projects/myapp
```

**Extra directories**: Mount additional directories with `--add-dir`. Each appears at `/extra/<dirname>` inside the container and is automatically registered with Claude Code via `--add-dir`.

```bash
moat --add-dir ~/Projects/shared-lib
moat ~/Projects/myapp --add-dir ~/lib-a --add-dir ~/lib-b
```

**Claude args**: Anything that isn't a workspace path or `--add-dir` flag is passed through to Claude Code.

```bash
moat ~/Projects/myapp --resume     # resume previous session
moat . --model sonnet              # pass model flag
```

### `moat plan` — Read-only mode

```bash
moat plan [workspace] [--add-dir <path>...] [claude_args...]
```

Launches Claude Code with only read-only tools enabled: `Read`, `Grep`, `Glob`, `Task`, `WebFetch`, `WebSearch`. Write, Edit, Bash, and all other mutating tools are blocked.

Use this for research and planning phases where you want Claude to analyze code without making changes.

```bash
moat plan                         # read-only, workspace = cwd
moat plan ~/Projects/myapp        # read-only on specific dir
```

### `moat attach <dir>` — Live-sync a directory into a running session

```bash
moat attach <directory>
```

Attaches an additional directory to a running moat session using [Mutagen](https://mutagen.io/) two-way file sync. The directory appears at `/extra/<dirname>` inside the container.

Unlike `--add-dir` (which requires a container restart), `moat attach` works while Claude is running. Files sync both ways in real-time.

```bash
moat attach ~/Projects/shared-lib     # syncs to /extra/shared-lib
moat attach ~/data/fixtures           # syncs to /extra/fixtures
```

After attaching, tell Claude about the new directory:

> "I have an additional directory at /extra/shared-lib"

**With mutagen** (`brew install mutagen-io/mutagen/mutagen`): files sync live in both directions, no restart needed.

**Without mutagen**: falls back to restarting the container with the directory as a bind mount. This ends the current Claude session — you'll be prompted for confirmation. Resume with `moat --resume` afterward.

### `moat detach` — Remove a live-synced directory

```bash
moat detach <dir|--all>
```

Stops syncing a previously attached directory. Accepts a path or just the basename.

```bash
moat detach shared-lib                # stop syncing shared-lib
moat detach ~/Projects/shared-lib     # same thing (basename is used)
moat detach --all                     # stop all moat sync sessions
```

Sync sessions are also cleaned up automatically when the moat session exits.

### `moat init` — Initialize project configuration

```bash
moat init [workspace]
```

Scans your project for dependency files and interactively creates a `.moat.yml` with detected services.

Scans:
- `package.json` — looks for `pg`, `redis`, `mongoose`, `mysql2`, `amqplib`, etc.
- `requirements.txt` / `pyproject.toml` — looks for `psycopg2`, `redis`, `pymongo`, `celery`, etc.
- `go.mod` — looks for `lib/pq`, `go-redis`, `mongo-driver`, etc.
- `.env.example` / `.env.sample` — looks for `DATABASE_URL`, `REDIS_URL`, `MONGO_URL` patterns

Detected services: `postgres`, `redis`, `mongo`, `mysql`, `rabbitmq`.

```bash
moat init                         # scan cwd, create .moat.yml
moat init ~/Projects/myapp        # scan specific directory
```

This also runs automatically on first `moat` launch when no `.moat.yml` exists.

### `moat update` — Update and rebuild

```bash
moat update [--version <version>]
```

Pulls the latest code from the repo and rebuilds the Docker image with `--no-cache`.

```bash
moat update                       # pull latest + rebuild
moat update --version 1.2.3       # rebuild with specific Claude Code version
```

### `moat doctor` — Diagnose setup issues

```bash
moat doctor
```

Runs diagnostic checks and reports PASS/FAIL/WARN for each:

| Check | Type |
|-------|------|
| `~/.local/bin/moat` symlink correct | FAIL if missing |
| Proxy token exists in data dir | FAIL if missing |
| Proxy token synced to repo | WARN if missing |
| `docker` command available | FAIL if missing |
| `node` command available | FAIL if missing |
| `devcontainer` CLI available | FAIL if missing |
| Docker daemon responding | FAIL if not |
| Docker image built | WARN if not |
| Tool proxy on :9876 | INFO (only during sessions) |
| `ANTHROPIC_API_KEY` set | FAIL if not |
| `mutagen` installed | INFO (optional, for attach/detach) |

Exits with code 1 if any FAILs, 0 otherwise.

## Session lifecycle

When you run `moat`:

1. Arguments are parsed (workspace, --add-dir, subcommands, claude args)
2. If no `.moat.yml` exists, dependency files are scanned and you're prompted to create one
3. Compose override files are generated from `.moat.yml`
4. Tool proxy starts on the host at `127.0.0.1:9876`
5. Container is checked — reused if workspace and mounts match, recreated otherwise
6. `devcontainer up` starts squid (forward proxy) + devcontainer
7. `~/.claude/CLAUDE.md` is copied into the container (if it exists)
8. Claude Code launches with `--dangerously-skip-permissions`
9. On exit (or Ctrl-C), the proxy is stopped and Mutagen sessions are terminated

Containers are **reused** across sessions when the workspace and extra directories haven't changed. On exit, only the tool proxy is stopped — containers keep running for fast re-launch. Bash history and Claude config persist across sessions via Docker volumes. Any Mutagen sync sessions (from `moat attach`) are terminated on exit.

## What works inside the container

### Network access

Only whitelisted domains are reachable (via squid proxy). Default whitelist:

- GitHub (`.github.com`, `.githubusercontent.com`, `.githubassets.com`)
- npm (`.npmjs.org`)
- Anthropic (`.anthropic.com`)
- Claude (`.claude.ai`, `.claude.com`)
- Sentry (`.sentry.io`)
- Statsig (`.statsig.com`)
- VS Code marketplace
- Host tool proxy (`host.docker.internal`)

Everything else is blocked. Direct connections bypassing the proxy are blocked at the network level.

To add a domain, edit `squid.conf`:

```
acl allowed_domains dstdomain .example.com
```

Then re-run `moat` (rebuilds automatically).

### Git and GitHub

Git and `gh` commands inside the container are proxied to the host via wrapper scripts. Your host credentials (SSH keys, GitHub tokens) never enter the container.

- `git` commands under `/workspace` are proxied; outside `/workspace` they use the container's git directly
- All `gh` commands are proxied

### IaC tools

Terraform, kubectl, and AWS CLI are available inside the container but restricted to read-only operations. Like git and gh, IaC commands are proxied to the host — credentials (AWS profiles, kubeconfigs, cloud tokens) stay on the host and never enter the container. The tool proxy validates every command before execution and rejects anything outside the allow-list.

#### Terraform

| | Commands |
|---|---|
| **Allowed** | `init`, `plan`, `validate`, `fmt`, `show`, `output`, `graph`, `providers`, `version`, `workspace`, `state`, `console` |
| **Blocked** | Everything else (`apply`, `destroy`, `taint`, `import`, `refresh`, etc.) |

Sub-command restrictions:

- `terraform state` — only `list`, `show`, `pull` (blocks `mv`, `rm`, `push`, `replace-provider`)
- `terraform workspace` — only `list`, `show`, `select` (blocks `new`, `delete`)

#### kubectl

| | Commands |
|---|---|
| **Allowed** | `get`, `describe`, `logs`, `top`, `api-resources`, `api-versions`, `cluster-info`, `config`, `version`, `auth`, `diff`, `explain`, `wait`, `events` |
| **Blocked** | Everything else (`apply`, `delete`, `create`, `patch`, `exec`, `edit`, `run`, `scale`, `rollout`, etc.) |

Sub-command restrictions:

- `kubectl config` — only `view`, `get-contexts`, `current-context`, `get-clusters`, `get-users` (blocks `set-context`, `use-context`, `set-credentials`, `delete-context`, etc.)
- `kubectl auth` — only `can-i`, `whoami` (blocks `reconcile`)

#### AWS CLI

AWS commands are validated by the verb prefix of the action (the part before the first `-`).

| | Verb prefixes |
|---|---|
| **Allowed** | `describe-*`, `list-*`, `get-*`, and any other verb not in the blocked set |
| **Blocked** | `create`, `delete`, `terminate`, `remove`, `put`, `update`, `run`, `start`, `stop`, `reboot`, `modify`, `release`, `deregister`, `revoke`, `disable`, `enable`, `attach`, `detach`, `associate`, `disassociate`, `import`, `export`, `invoke`, `publish`, `send`, `execute`, `cancel`, `reset`, `restore` |

For example, `aws ec2 describe-instances` is allowed but `aws ec2 terminate-instances` is blocked.

All IaC restrictions are enforced server-side on the host tool proxy — the container cannot bypass them.

### Docker access

When `docker: true` is set in `.moat.yml`, Docker commands are available inside the sandbox via rootless [Podman](https://podman.io/). The `docker` command is aliased to `podman`, so existing workflows and Dockerfiles work without changes.

Unlike a Docker socket proxy, Podman runs containers as **child processes of the devcontainer**. This means all container traffic inherits the sandbox network and goes through squid — the domain whitelist is enforced on everything, including `docker build` and `docker run`.

#### Enabling

Add to your `.moat.yml`:

```yaml
docker: true
```

Then re-run `moat`. You'll see "Docker access enabled via Podman (rootless)" in the startup output.

When docker is enabled, moat auto-adds these domains to the squid whitelist:
- `.docker.io`, `.docker.com`, `production.cloudflare.docker.com` (Docker Hub)
- `.debian.org`, `.ubuntu.com`, `.alpinelinux.org` (OS package repos for Dockerfiles)

#### What works

```bash
docker build -t myapp .              # Build images from Dockerfiles
docker build -f other/Dockerfile .   # Build with a custom Dockerfile path
docker run myapp                     # Run a container
docker run -d -p 8080:80 nginx       # Run detached with port mapping
docker compose up                    # Start services from docker-compose.yml
docker compose up -d                 # Detached mode
docker compose down                  # Stop services
docker images                        # List images
docker ps                            # List containers
docker logs <container>              # View container logs
docker stop <container>              # Stop a container
docker rm <container>                # Remove a container
docker volume ls                     # List volumes
docker network ls                    # List networks
docker info                          # Engine info
```

Volume mounts work within the container:

```bash
docker run -v mydata:/data myapp           # Named volume — OK
docker run --tmpfs /tmp myapp              # tmpfs — OK
docker run -v ./src:/app myapp             # Bind mount from workspace — OK
```

#### How it works

```
devcontainer (sandbox network)
    │
    │  docker build / docker run / docker compose
    │  (docker → podman alias)
    ▼
Podman (rootless, daemonless)
    │  Runs containers as child processes
    │  Network via slirp4netns
    ▼
All traffic → squid:3128 → internet
              (domain whitelist enforced)
```

Podman runs entirely inside the devcontainer with no connection to the host Docker daemon:

1. **No socket mount** — the host Docker socket (`/var/run/docker.sock`) is never exposed
2. **Rootless** — Podman runs as the `node` user, not root
3. **Network inherited** — containers use slirp4netns which routes through the devcontainer's network stack, so all traffic goes through squid
4. **Daemonless** — no long-running daemon, no privileged socket to protect

The `docker: true` flag adds `/dev/fuse` (for the fuse-overlayfs storage driver) and relaxes seccomp (so Podman can create user namespaces). Without `docker: true`, Podman is installed but can't run containers.

#### Security properties

| Property | Status |
|----------|--------|
| Squid domain whitelist on `docker run` | **Enforced** — traffic goes through sandbox network |
| Squid domain whitelist on `docker build` (RUN instructions) | **Enforced** — builds happen inside the container |
| Host Docker socket exposure | **None** — Podman is daemonless |
| Host filesystem access | **None** — no connection to host daemon |
| Host container visibility | **None** — Podman sees only its own containers |
| Image pull/push | **Through squid** — domain whitelist enforced |
| Container resource limits | **Bounded by devcontainer limits** (4 CPUs, 8GB) |

#### Adding registry and package domains

Since all traffic goes through squid, you may need to whitelist additional domains for your Dockerfiles. Common examples:

```yaml
# .moat.yml
docker: true
domains:
  # Container registries (Docker Hub is auto-added)
  - .ghcr.io              # GitHub Container Registry
  - .quay.io              # Red Hat Quay
  - .gcr.io               # Google Container Registry
  # Package repos (debian/ubuntu/alpine are auto-added)
  - .centos.org           # CentOS packages
  - .fedoraproject.org    # Fedora packages
  - .crates.io            # Rust packages
  - .rubygems.org         # Ruby packages
```

If a `docker build` fails with a network error during a RUN instruction, check whether the required domain is in your squid whitelist.

#### Compose

`docker compose` is supported via `podman-compose`. Most docker-compose.yml files work without changes:

```yaml
# docker-compose.yml (your project's, inside the sandbox)
services:
  app:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./src:/app/src
    depends_on:
      - db
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: dev
```

```bash
docker compose up       # builds and starts both services
docker compose down     # stops and removes
docker compose logs -f  # follow logs
```

Note: `podman-compose` handles most compose features but may differ from Docker Compose on edge cases (deploy configs, some network modes). Standard build/run/volumes/ports/depends_on/environment all work.

#### Known limitations

**Seccomp is relaxed.** When `docker: true` is enabled, the devcontainer runs with `seccomp=unconfined` so Podman can create user namespaces. This disables kernel syscall filtering — a defense-in-depth layer. The sandbox network isolation (squid) and rootless execution remain intact.

**Build cache is ephemeral.** Podman stores images and layers inside the devcontainer. Running `moat down` destroys the container and all cached images/layers. Subsequent builds start from scratch. Images persist across `moat` sessions as long as the container isn't destroyed.

**Podman-compose compatibility.** `podman-compose` handles most docker-compose.yml features but isn't 100% identical to Docker Compose. Complex compose features (deploy, configs, secrets) may behave differently.

### IDE tools

Claude has access to two MCP servers inside the container:

**ide-tools** — diagnostics and testing:
- `run_diagnostics` — full type-check/lint (tsc, pyright, golangci-lint)
- `run_tests` — structured test output (vitest/jest, pytest, go test)
- `list_tests` — list available tests without running them
- `get_project_info` — detect language, framework, test runner, build system

**ide-lsp** — code intelligence via persistent language servers:
- `lsp_hover` — type info and docs at a position
- `lsp_definition` — go to definition
- `lsp_references` — find all references
- `lsp_diagnostics` — errors/warnings for a file
- `lsp_symbols` — list symbols in a file
- `lsp_workspace_symbols` — search symbols across the workspace

Language servers (typescript-language-server, pyright, gopls) start lazily on first use.

**Auto-diagnostics**: After every file edit, fast linters run automatically (eslint for JS/TS, ruff for Python, go vet for Go) and inject results into Claude's context.

## File layout

```
~/.local/bin/moat                → <repo>/moat.mjs (executable Node.js)
~/.devcontainers/moat/           → <repo> (symlink, used by devcontainer)
~/.moat/data/.proxy-token          (persistent bearer token)
~/.claude/CLAUDE.md                (optional, copied into container on launch)
```

The repo itself lives at `~/.moat` (curl install) or wherever you cloned it.

### Global CLAUDE.md

If `~/.claude/CLAUDE.md` exists on the host, Moat automatically copies it into the container at `/home/node/.claude/CLAUDE.md` after the container starts. This gives Claude Code access to your global instructions (preferences, conventions, etc.) inside the sandbox.

## Troubleshooting

**Claude can't reach a domain**: Add it to `squid.conf` and re-run `moat`.

**Docker daemon not running**: Launch Docker Desktop. `moat doctor` will tell you.

**Tool proxy unreachable**: Check `cat /tmp/moat-tool-proxy.log` on the host. Verify with `curl http://127.0.0.1:9876/health`.

**Stale session**: If containers are stuck, `moat` cleans up previous sessions automatically on start. You can also manually run `docker compose --project-name moat down`.

**npm install fails inside container**: Ensure `.npmjs.org` is in `squid.conf`.

**git clone fails for non-GitHub host**: Add that domain to `squid.conf`. Git is configured to use HTTPS (SSH can't traverse the HTTP proxy).
