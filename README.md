# Moat

A sandboxed environment for running [Claude Code](https://github.com/anthropics/claude-code) with network isolation, credential isolation, and infrastructure-as-code safety controls.

Claude Code runs inside a Docker container with `--dangerously-skip-permissions`. Moat makes that safe by ensuring the container can only reach whitelisted domains, never touches cloud credentials directly, and cannot mutate infrastructure.

### Why "Moat"?

A [moat](https://en.wikipedia.org/wiki/Moat) is a defensive ditch surrounding a castle — it doesn't make the castle invincible, but it controls what can cross the boundary. Moat does the same for AI coding agents: the container is the castle, and the network/credential isolation is the moat around it. Everything that enters or leaves goes through controlled checkpoints (squid proxy, tool proxy), not over the wall.

## How it works

```
                    Internet
                       |
              External Network (extnet)
                       |
                 +-----------+
                 |   squid   |  Domain whitelist
                 |   :3128   |  (fail-closed)
                 +-----------+
                       |
          Internal Network (sandbox)
                       |
              +---------------+           +-----------+
              |  devcontainer |  -------> | tool proxy |  (host)
              |  Claude Code  |  :9876    | credentials|
              +---------------+           +-----------+
```

**Network isolation**: The container sits on an `internal: true` Docker network with zero direct egress. All traffic goes through a squid forward proxy that whitelists specific domains.

**Credential isolation**: Cloud credentials (AWS, GCP, Azure, GitHub) never enter the container. A host-side tool proxy executes commands on behalf of the container, returning only stdout/stderr/exitCode.

**IaC safety**: Terraform is plan-only. kubectl is read-only. AWS CLI blocks mutating verbs. All enforced server-side on the host.

## Quick start

**Option A — curl installer**:

```bash
curl -fsSL https://raw.githubusercontent.com/srinivasgumdelli/moat/main/install.sh | bash
```

**Option B — clone first**:

```bash
git clone git@github.com:srinivasgumdelli/moat.git
cd moat
./install.sh
```

Both run the same installer. If Homebrew is available, missing prerequisites (Docker, Node, git) are installed automatically. Without Homebrew, the installer checks and tells you what to install.

Then:

```bash
moat                                        # full access (workspace = cwd)
moat ~/Projects/myapp                       # target a specific directory
moat --add-dir ~/Projects/shared-lib        # mount extra directories
moat ~/Projects/myapp --add-dir ~/lib-a --add-dir ~/lib-b
moat init                                   # scan deps, create .moat.yml interactively
moat attach ~/Projects/shared-lib           # live-sync a dir into a running session
moat detach shared-lib                      # stop syncing
```

On first run in a workspace without `.moat.yml`, Moat scans dependency files (`package.json`, `requirements.txt`, `go.mod`, `.env.example`) and offers to create a `.moat.yml` with detected services.

If `~/.claude/CLAUDE.md` exists on the host, it is automatically copied into the container so Claude Code has your global instructions.

**Diagnose** setup issues:

```bash
moat doctor
```

**Update** (pulls latest code + rebuilds the Docker image):

```bash
moat update
```

Extra directories are mounted at `/extra/<dirname>` inside the container and automatically registered with Claude Code via `--add-dir`.

See [docs/usage.md](docs/usage.md) for the full usage guide.

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| Docker Desktop | Yes | https://docker.com/products/docker-desktop |
| Node.js | Yes | `brew install node` |
| gh CLI | Optional | `brew install gh && gh auth login` |
| terraform | Optional | `brew install terraform` (on host, for proxy) |
| kubectl | Optional | `brew install kubectl` (on host, for proxy) |
| aws CLI | Optional | `brew install awscli` (on host, for proxy) |
| mutagen | Optional | `brew install mutagen-io/mutagen/mutagen` (for `moat attach` live-sync) |

## Security layers

| Layer | What it prevents |
|-------|-----------------|
| Docker internal network | Direct outbound connections |
| Squid domain whitelist | Access to non-whitelisted domains |
| CONNECT restriction | Tunneling to arbitrary ports |
| No external DNS | DNS-based exfiltration |
| Tool proxy allowlists | Destructive terraform/kubectl/aws commands |
| Credential isolation | Cloud creds entering the container |
| Bearer token auth | Unauthorized proxy access |
| Proxy binds 127.0.0.1 | Network-level proxy access |
| Non-root user | Privilege escalation |
| Resource limits | CPU/memory exhaustion |
| Container rebuild on change | Stale state from previous workspace |
| Podman (rootless, daemonless) | No host socket, containers inherit squid, no host filesystem access |

### Security considerations

Moat is designed to be **fail-closed** — if a process ignores proxy settings or tries to connect directly, the Docker internal network blocks it. But it's not a perfect sandbox. Here's what to be aware of:

**What Moat prevents:**
- Exfiltrating data to unauthorized domains
- Using cloud credentials to mutate infrastructure (terraform apply, kubectl delete, aws create-*)
- Accessing cloud credentials directly (they never enter the container)
- Reaching arbitrary internet endpoints

**What Moat does NOT prevent:**
- Reading and writing files in your mounted workspace (`~/Repos` or whatever you mount)
- Running arbitrary code inside the container (that's the point — Claude needs bash)
- Installing packages from whitelisted registries (npm, pip, etc.)
- Making requests to whitelisted domains (GitHub, npm, Anthropic, etc.)

**Accepted trade-offs:**
- **Workspace is read-write**: Claude needs to edit code. Limit the mount to what's needed, not your entire home directory.
- **ANTHROPIC_API_KEY enters the container**: This is the one credential that must be inside. It's protected by network isolation (can only reach `anthropic.com` through squid).
- **`seccomp=unconfined` when `docker: true`**: Disables kernel syscall filtering so Podman can create user namespaces. Mitigated by capability restrictions and network isolation.
- **Whitelisted domains are trusted**: If a whitelisted domain is compromised, the container can reach it. Keep the whitelist minimal.

**Recommendations:**
- Review `.moat.yml` domains — only whitelist what your project needs
- Run `moat doctor` to verify your setup is correctly configured
- Keep Docker Desktop and your host kernel updated (relevant when `docker: true`)

## Background agents

Spawn read-only Claude Code agents that run in the background — research code, run tests, analyze patterns — without blocking your main session:

```bash
agent run "run all tests and summarize failures"
agent run --name research "explain the auth flow"
agent list                    # see all agents
agent log <id>                # view output
agent kill <id>               # terminate
```

Agents are read-only by default (no file writes), so they can't conflict with your main session. The status line shows running agent count alongside model, task, context usage, and cost.

## IDE features

The container includes IDE-level tooling for TypeScript, Python, and Go:

**Auto-diagnostics** (PostToolUse hook): After every file edit, fast linters run automatically and inject diagnostics into Claude's context:
- TypeScript/JavaScript: project-local `eslint`
- Python: `ruff`
- Go: `go vet`

**Deep analysis tools** (`ide-tools` MCP server): Claude can explicitly call:
- `run_diagnostics` — full type-check/lint (`tsc --noEmit`, `pyright`, `golangci-lint`)
- `run_tests` — structured test output (`vitest`/`jest`, `pytest`, `go test`)
- `list_tests` — list available tests without running them
- `get_project_info` — detect language, framework, test runner, build system

**Code intelligence** (`ide-lsp` MCP server): Persistent language server connections give Claude:
- `lsp_hover` — type info and docs at a position
- `lsp_definition` — go to definition
- `lsp_references` — find all references
- `lsp_diagnostics` — errors/warnings for a file
- `lsp_symbols` — list symbols in a file
- `lsp_workspace_symbols` — search symbols across workspace

Language servers (`typescript-language-server`, `pyright`, `gopls`) start lazily on first use and persist for the session.

## IaC safety controls

**Terraform** (plan-only): `init`, `plan`, `validate`, `fmt`, `show`, `output`, `graph`, `providers`, `version` are allowed. `apply`, `destroy`, `import`, `taint` are blocked.

**kubectl** (read-only): `get`, `describe`, `logs`, `top`, `diff`, `explain` are allowed. `apply`, `delete`, `create`, `exec`, `patch` are blocked.

**AWS CLI** (read-only): Actions starting with `describe`, `list`, `get` are allowed. Actions starting with `create`, `delete`, `terminate`, `put`, `update`, `run` are blocked.

## Per-project configuration

Create a `.moat.yml` in your workspace root to configure background services, environment variables, and extra allowed domains per project. You can create one manually or let Moat generate it:

```bash
moat init                    # interactive: scans deps, prompts for each service
```

Moat also auto-detects dependencies on first run if no `.moat.yml` exists. It scans `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, and `.env.example` for common service dependencies (postgres, redis, mongo, mysql, rabbitmq).

Example `.moat.yml`:

```yaml
# .moat.yml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: moat
      POSTGRES_DB: dev
  redis:
    image: redis:7

env:
  DATABASE_URL: postgres://postgres:moat@postgres:5432/dev
  REDIS_URL: redis://redis:6379

domains:
  - .crates.io
  - .docker.io
```

All sections are optional. See `moat.example.yml` for a fully documented example.

### Docker access

Add `docker: true` to `.moat.yml` to enable Docker CLI and Compose inside the sandbox:

```yaml
docker: true
```

Then inside the container:

```bash
docker build -t myapp .              # Build images
docker run myapp                     # Run containers
docker run -d -p 8080:80 nginx       # Detached with port mapping
docker compose up                    # Start services from docker-compose.yml
docker compose down                  # Stop services
docker ps / docker images / docker logs
```

No host dependencies beyond Docker Desktop — Podman is installed inside the container image. Docker Hub and common OS package repos (debian, ubuntu, alpine) are auto-added to the squid whitelist. For other registries, add them to `domains:` in `.moat.yml`:

```yaml
docker: true
domains:
  - .ghcr.io        # GitHub Container Registry
  - .quay.io        # Red Hat Quay
```

Docker commands are provided by rootless [Podman](https://podman.io/) (`docker` is aliased to `podman`). Unlike a Docker socket proxy, Podman runs containers as **child processes of the devcontainer** — all traffic inherits the sandbox network and goes through squid. No host Docker socket is exposed.

| Property | How |
|----------|-----|
| Squid whitelist on builds and runs | Podman inherits sandbox network |
| No host socket exposure | Podman is daemonless |
| No host filesystem access | No connection to host daemon |
| No host container visibility | Podman sees only its own containers |
| Resource limits | Bounded by devcontainer limits |

See [docs/usage.md](docs/usage.md#docker-access) for full details, compose examples, and known limitations.

### Background services

Services defined in `.moat.yml` run as Docker containers on the sandbox network alongside the devcontainer. They're accessible by service name (e.g., `psql -h postgres`).

Smart defaults are applied for known images:

| Image | Healthcheck | CPU | Memory |
|-------|------------|-----|--------|
| `postgres:*` | `pg_isready` | 1 | 1G |
| `redis:*` | `redis-cli ping` | 0.5 | 512M |
| `mysql:*` | `mysqladmin ping` | 1 | 1G |
| `mariadb:*` | `mysqladmin ping` | 1 | 1G |
| `mongo:*` | `mongosh ping` | 1 | 1G |
| Other | none | 1 | 1G |

The devcontainer waits for services with healthchecks to be healthy before starting.

### Extra domains

Domains listed under `domains:` are added to the squid proxy whitelist for that project. Use a leading dot to match the domain and all subdomains.

## Adding domains to the whitelist

For global domain changes, edit `squid.conf` and add:

```
acl allowed_domains dstdomain .example.com
```

For per-project domains, use the `domains:` section in `.moat.yml` instead.

Then re-run `moat` (the container rebuilds automatically).

## Project structure

```
moat/
├── moat.mjs                      # Entry point (executable): argument routing, main flow, cleanup
├── lib/
│   ├── colors.mjs                # Terminal colors (TTY detection), log(), err()
│   ├── exec.mjs                  # child_process wrappers: runCapture, runInherit, etc.
│   ├── yaml.mjs                  # Minimal YAML parser for .moat.yml
│   ├── cli.mjs                   # Argument parsing (workspace, --add-dir, subcommands)
│   ├── compose.mjs               # Compose + squid file generation
│   ├── container.mjs             # Container lifecycle: check, reuse, teardown, start, exec
│   ├── proxy.mjs                 # Tool proxy lifecycle: start, stop, health check
│   ├── doctor.mjs                # doctor subcommand
│   ├── update.mjs                # update subcommand
│   ├── down.mjs                  # down subcommand
│   ├── attach.mjs                # attach/detach subcommands
│   ├── detect.mjs                # Dependency scanner (package.json, go.mod, etc.)
│   ├── init-config.mjs           # Interactive .moat.yml creation from detected deps
│   └── claude-md.mjs             # Copy global CLAUDE.md into container
├── install.sh                    # Unified installer (curl-pipeable, auto-detects context)
├── tool-proxy.mjs                # Host-side proxy server with allowlists
├── Dockerfile                    # Container image
├── docker-compose.yml            # squid + devcontainer services
├── docker-compose.services.yml   # Per-project sidecar services (auto-generated)
├── docker-compose.extra-dirs.yml # Extra directory mounts (auto-generated)
├── devcontainer.json             # devcontainer CLI config
├── squid.conf                    # Domain whitelist (base)
├── squid-runtime.conf            # Domain whitelist + project domains (auto-generated)
├── moat.example.yml              # Example .moat.yml config
├── test.sh                       # End-to-end test suite
├── verify.sh                     # Post-start verification
├── *-proxy-wrapper.sh            # Container-side tool wrappers (git, gh, terraform, etc.)
├── auto-diagnostics.sh           # PostToolUse hook for linting after edits
├── ide-tools.mjs                 # MCP server: diagnostics, tests, project info
├── ide-lsp.mjs                   # MCP server: LSP code intelligence
└── docs/
    ├── usage.md                  # Full usage guide
    ├── setup.md                  # Detailed setup / architecture
    ├── project-plan.md           # Roadmap and architecture decisions
    └── ideas.md                  # Future IDE features
```

