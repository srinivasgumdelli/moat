# Moat

A sandboxed environment for running [Claude Code](https://github.com/anthropics/claude-code) with network isolation, credential isolation, and infrastructure-as-code safety controls.

Claude Code runs inside a Docker container with `--dangerously-skip-permissions`. Moat makes that safe by ensuring the container can only reach whitelisted domains, never touches cloud credentials directly, and cannot mutate infrastructure.

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
moat plan                                   # read-only tools only (no Write, Edit, Bash)
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

