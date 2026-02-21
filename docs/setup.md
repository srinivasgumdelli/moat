# Moat — Sandboxed DevContainer Setup

## Overview

This document describes the sandboxed development container setup for running Claude Code with network isolation. Moat runs Claude Code inside a Docker container that can only access whitelisted domains through a forward proxy, preventing unauthorized network access.

## Problem

The original setup used `iptables` firewall rules inside the container to restrict outbound network access. This approach failed on Apple Silicon Macs because:

1. The original `mcr.microsoft.com/devcontainers/universal:2` base image was amd64-only, requiring Rosetta emulation (now replaced with `node:22` which has native arm64)
2. `iptables` (both legacy and nft backends) cannot access kernel netfilter modules under Rosetta
3. The firewall script required `NET_ADMIN`/`NET_RAW` capabilities and root access

## Solution: Docker Network Isolation + Squid Forward Proxy

Instead of filtering traffic inside the container with iptables, we use two layers of isolation:

1. **Docker network isolation** (`internal: true`) prevents the container from having any direct external network access
2. **Squid forward proxy** runs as a sidecar container, whitelisting specific domains via ACLs

This is a **fail-closed** design: even if a process inside the container ignores the proxy environment variables and tries to connect directly, the Docker network blocks it.

## Architecture

```
                    Internet
                       |
              External Network (extnet)
                       |
                 +-----------+
                 |   squid   |  ARM64 native (no emulation)
                 |   :3128   |  Domain whitelist ACLs
                 +-----------+
                    |       |
       sandbox network     extnet --> host.docker.internal:9876
                    |                          |
              +-----------+             +-----------+
              | devcontainer |          | tool-proxy |  (runs on host)
              | Claude Code  |          | gh/git ops |  (has credentials)
              | git/gh wrappers        +-----------+
              +-----------+
```

Key properties:
- The devcontainer is ONLY connected to the `sandbox` network (marked `internal: true`)
- Squid bridges both `sandbox` and `extnet` networks
- All HTTP/HTTPS traffic from the devcontainer routes through squid on port 3128
- Squid runs natively on ARM64 — no Rosetta emulation needed
- The devcontainer cannot perform external DNS lookups (Docker's embedded DNS only resolves container names)
- Git/gh CLI wrappers inside the container proxy commands to a host-side tool proxy, keeping credentials off the container
- Containers are reused across sessions when workspace and extra directories haven't changed — only the tool proxy is stopped on exit. Bash history and Claude config persist via Docker volumes

## File Structure

`~/.devcontainers/moat/` is a **symlink** pointing to the cloned repo (default: `~/.moat` for curl installs, or wherever you cloned for local installs). Runtime data lives in `~/.moat/data/`.

```
~/.devcontainers/moat/ → <repo>        # Symlink to cloned repo
├── moat.mjs               # Entry point (executable): argument routing, main flow, cleanup
├── lib/                   # Node.js modules (zero npm dependencies)
│   ├── colors.mjs         # Terminal colors, log(), err()
│   ├── exec.mjs           # child_process wrappers
│   ├── yaml.mjs           # Minimal YAML parser for .moat.yml
│   ├── cli.mjs            # Argument parsing
│   ├── compose.mjs        # Compose + squid file generation
│   ├── container.mjs      # Container lifecycle
│   ├── proxy.mjs          # Tool proxy lifecycle
│   ├── doctor.mjs         # doctor subcommand
│   ├── update.mjs         # update subcommand
│   ├── down.mjs           # down subcommand
│   ├── attach.mjs         # attach/detach subcommands
│   ├── detect.mjs         # Dependency scanner
│   ├── init-config.mjs    # Interactive .moat.yml creation
│   └── claude-md.mjs      # Copy global CLAUDE.md into container
├── devcontainer.json      # DevContainer CLI configuration
├── docker-compose.yml     # Two-service setup (squid + devcontainer)
├── Dockerfile             # DevContainer image (node:22, Claude Code, git-delta)
├── squid.conf             # Squid proxy domain whitelist
├── tool-proxy.mjs         # Host-side Node.js server for gh/git credential isolation
├── *-proxy-wrapper.sh     # Container-side tool wrappers (git, gh, terraform, etc.)
├── install.sh             # Unified installer (curl-pipeable, auto-detects context)
├── .proxy-token           # Copied from DATA_DIR before builds (in .gitignore)
└── verify.sh              # Post-start verification script

~/.moat/data/
└── .proxy-token           # Persistent bearer token (source of truth)
```

## How Each File Works

### docker-compose.yml

Defines two services:

**squid** — The forward proxy:
- Image: `ubuntu/squid:latest` (ARM64 native)
- Connected to both `sandbox` (internal) and `extnet` (external) networks
- Mounts `squid.conf` read-only
- Healthcheck: `squid -k check` every 10s

**devcontainer** — The Claude Code environment:
- Built from `Dockerfile` (native arm64 on Apple Silicon)
- Connected to `sandbox` network ONLY (no external access)
- Waits for squid to be healthy before starting
- Sets proxy env vars: `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy` (both cases for tool compatibility)
- Mounts `~/Repos` at `/workspace`
- Persistent volumes for bash history and Claude config
- Resource limits: 4 CPUs, 8GB RAM

**squid** resource limits: 0.5 CPUs, 256MB RAM

Two networks:
- `sandbox` (`internal: true`) — isolated, no external routing
- `extnet` — standard bridge with external access (squid only)

### squid.conf

Squid forward proxy configuration with domain whitelist ACLs:

| Category | Domains | Purpose |
|----------|---------|---------|
| GitHub | `.github.com`, `.githubusercontent.com`, `.githubassets.com` | Git operations, raw content, assets |
| npm | `.npmjs.org` | Package registry |
| Anthropic | `.anthropic.com` | Claude API |
| Sentry | `.sentry.io` | Error tracking |
| Statsig | `.statsig.com` | Feature flags/analytics |
| VS Code | `marketplace.visualstudio.com`, `vscode.blob.core.windows.net`, `update.code.visualstudio.com`, `.vo.msecnd.net`, `.gallerycdn.vsassets.io` | Extension marketplace, updates |
| Claude | `.claude.ai`, `.claude.com` | Claude platform |
| Tool proxy | `host.docker.internal` | Host-side tool proxy for gh/git credential isolation |

Rules:
1. Deny CONNECT to non-SSL ports (prevents tunneling to arbitrary ports)
2. Allow traffic to whitelisted domains
3. Deny everything else

Leading dot (`.github.com`) matches the domain and all subdomains.

### Dockerfile

Based on `node:22` (native arm64 on Apple Silicon):

1. Installs basic development tools (git, jq, zsh, curl, etc.) via apt-get
2. Persists bash history across container restarts
3. Creates workspace and Claude config directories
4. Installs git-delta for enhanced diffs
5. Installs IaC tools (terraform, kubectl, aws-cli) with arch-aware downloads
6. Installs Podman ecosystem (podman, buildah, fuse-overlayfs, slirp4netns, uidmap) for rootless Docker access. Configures subuid/subgid mapping, overlay storage via fuse-overlayfs, cgroupfs cgroup manager, and slirp4netns networking. Installs podman-compose and a `docker` → `podman` compatibility wrapper
7. Installs Claude Code CLI (`@anthropic-ai/claude-code`) in user-writable npm prefix
8. Configures git to use HTTPS instead of SSH (SSH can't traverse an HTTP proxy)
9. Copies tool proxy wrapper scripts (`git-proxy-wrapper.sh` → `/usr/local/bin/git`, `gh-proxy-wrapper.sh` → `/usr/local/bin/gh`, plus terraform/kubectl/aws wrappers) — these shadow the real binaries since `/usr/local/bin` is earlier in `PATH` than `/usr/bin`
10. Copies the verification script

No firewall packages (iptables, ipset, etc.) are needed.

### devcontainer.json

Tells the devcontainer CLI to use docker-compose mode:
- References `docker-compose.yml` and the `devcontainer` service
- Passes `ANTHROPIC_API_KEY` from the host via `remoteEnv` (the `${localEnv:...}` syntax only works in devcontainer.json)
- Runs `verify.sh` as the `postStartCommand`
- Configures VS Code extensions (Claude Code, ESLint, Prettier, GitLens)

### verify-sandbox.sh

Runs on container start to validate the sandbox is working:

1. Checks `HTTPS_PROXY` environment variable is set
2. Tests allowed domain (api.github.com) is reachable through proxy
3. Tests blocked domain (example.com) is denied by proxy
4. Tests direct access bypassing proxy is blocked by network isolation
5. Checks git HTTPS rewrite is configured
6. Tests tool proxy health endpoint (`http://host.docker.internal:9876/health`) and verifies `/etc/tool-proxy-token` exists

No root/sudo required — runs as the `node` user.

## Tool Proxy (Credential Isolation)

Credentials (GitHub tokens, SSH keys) never enter the container. Instead, a host-side Node.js server executes `gh`/`git` commands on behalf of the container.

### How It Works

Zero dynamic configuration — everything is static/baked-in:

1. A **static bearer token** is generated once (`openssl rand -hex 32`) and stored in `~/.moat/data/.proxy-token`. It is copied into the repo dir before Docker builds (the copy is in `.gitignore`), then baked into the Docker image at `/etc/tool-proxy-token`
2. The **proxy URL** (`http://host.docker.internal:9876`) is hardcoded in the wrapper scripts
3. The launcher script starts `tool-proxy.mjs --workspace ~/Repos` on the host before the container, with `MOAT_TOKEN_FILE` pointing to the data dir token
4. **Path translation happens on the proxy side**: wrappers send container paths as-is (e.g., `/workspace/projects`), the proxy translates to host paths (e.g., `~/Repos/projects`)
5. Inside the container, wrapper scripts at `/usr/local/bin/git` and `/usr/local/bin/gh` shadow the real binaries
6. When Claude runs `git status` in `/workspace/projects`, the git wrapper:
   - Detects CWD is under `/workspace` → uses the proxy
   - Sends a JSON POST with `{ args: ["status"], cwd: "/workspace/projects" }` to the proxy through squid
   - The proxy translates `/workspace/projects` → `~/Repos/projects` and executes `git status` on the host
   - Returns `{ stdout, stderr, exitCode }` — wrapper outputs the result
7. For paths outside `/workspace` (e.g., `/tmp`), the git wrapper falls through to the real `/usr/bin/git`

No environment variables, env files, or runtime config passing needed.

### tool-proxy.mjs

Single-file Node.js server with zero dependencies (uses `node:http`, `node:child_process`, `node:fs`):

- **Started with**: `node tool-proxy.mjs --workspace /path/to/host/workspace`
- **Binds to**: `127.0.0.1:9876` (localhost only — not reachable from the network, but accessible to Docker Desktop's `host.docker.internal` gateway)
- **Auth**: static bearer token read from `.proxy-token` file (same file baked into Docker image)
- **Path translation**: incoming `/workspace/*` paths are translated to `$HOST_WORKSPACE/*` host paths
- **Endpoints**:
  - `GET /health` — no auth required, returns `{ success: true }`
  - `POST /git` — bearer auth, body `{ args[], cwd }`, translates cwd, runs `git` on the host
  - `POST /gh` — bearer auth, body `{ args[], cwd? }`, translates cwd, runs `gh` with the host's `GITHUB_TOKEN` (from `gh auth token`, cached 10 min)
- **Response format**: `{ success, stdout, stderr, exitCode }`

### git-proxy-wrapper.sh

Installed at `/usr/local/bin/git`, shadows `/usr/bin/git`:

- **Smart routing**: if CWD is under `/workspace` AND `/etc/tool-proxy-token` exists → proxy; otherwise → real git
- **No path translation** — sends container paths as-is, proxy translates
- **Transport**: curl POST through squid (HTTP_PROXY env var routes automatically)
- **Serialization**: NUL-delimited printf + jq for safe JSON encoding of arguments; response validated as JSON before parsing
- **Graceful errors**: if proxy is unreachable, shows a clean one-line error instead of jq parse failures

### gh-proxy-wrapper.sh

Installed at `/usr/local/bin/gh`:

- All `gh` commands are proxied (no dual-path like git)
- Sends current working directory so proxy can translate for repo detection (`gh repo view`, `gh pr list`)
- Same transport and error handling as the git wrapper

## Usage

### Launcher Script

The sandbox is launched via `moat` (a symlink at `~/.local/bin/moat` → `<repo>/moat.mjs`). `moat.mjs` is a directly executable Node.js script (has `#!/usr/bin/env node` shebang). All logic lives in Node.js modules under `lib/`, using only Node.js built-ins (zero npm dependencies). Node resolves symlinks for `import.meta.url`, so `__dirname` correctly points to the repo regardless of how it's invoked.

```bash
# ~/.local/bin/moat is a symlink to <repo>/moat.mjs
# Ensure ~/.local/bin is on PATH (install.sh handles this automatically)
```

### Running

```bash
# Full sandbox with all tools
moat

# Plan mode — read-only tools only (no Write, Edit, Bash)
moat plan

# Initialize .moat.yml from detected dependencies
moat init

# Attach a directory to a running session (live-sync via mutagen, or restart fallback)
moat attach ~/Projects/shared-lib

# Detach a synced directory (or --all)
moat detach shared-lib

# Update (pull latest code + rebuild image)
moat update
```

### What Happens on Launch

1. `moat.mjs` parses arguments (workspace, --add-dir, subcommands, claude args)
3. Ensures `~/.moat/data/` exists with a proxy token (auto-generates or migrates from old installs)
4. If no `.moat.yml` exists, scans dependency files and offers to create one (auto-detection)
5. Generates compose override files from `.moat.yml` (services, squid domains, extra dirs)
6. Tool proxy starts on the host (`127.0.0.1:9876`), reads token via `MOAT_TOKEN_FILE` env var
7. Checks for a running container — reuses if workspace and extra directories match, recreates otherwise
8. `devcontainer up` starts squid + devcontainer (if needed), waits for squid health check
9. Copies `~/.claude/CLAUDE.md` into the container (if it exists on the host)
10. Claude Code launches with `--dangerously-skip-permissions` via `devcontainer exec`
11. On exit: synchronous cleanup kills proxy and terminates any Mutagen sync sessions (containers kept running for reuse)

### Update

`moat update` pulls the latest code via `git -C "$REPO_DIR" pull --ff-only`, then rebuilds the Docker image with `--no-cache`. To pin a specific Claude Code version: `moat update --version 1.0.0`.

### Teardown

Automatic on exit (bash EXIT trap). The script also cleans up any previous session on startup.

### Rebuild (after config changes)

Just run `moat` again — the cleanup runs first, and the devcontainer CLI detects Dockerfile/compose changes and rebuilds automatically.

## Per-Project Configuration

Create a `.moat.yml` file in your workspace root to customize Moat for each project.

### Background Services

Add database and cache services that run alongside the devcontainer:

```yaml
services:
  postgres:
    image: postgres:15
    env:
      POSTGRES_PASSWORD: moat
      POSTGRES_DB: dev
  redis:
    image: redis:7
```

Services run on the sandbox network and are accessible by name (e.g., `psql -h postgres -U postgres`).

Known images get automatic healthchecks and resource limits:
- `postgres:*` — `pg_isready`, 1 CPU / 1G RAM
- `redis:*` — `redis-cli ping`, 0.5 CPU / 512M RAM
- `mysql:*` / `mariadb:*` — `mysqladmin ping`, 1 CPU / 1G RAM
- `mongo:*` — `mongosh ping`, 1 CPU / 1G RAM
- Unknown images — no healthcheck, 1 CPU / 1G RAM

### Environment Variables

Inject environment variables into the devcontainer:

```yaml
env:
  DATABASE_URL: postgres://postgres:moat@postgres:5432/dev
  REDIS_URL: redis://redis:6379
```

### Extra Domains

Add project-specific domains to the squid proxy whitelist:

```yaml
domains:
  - .crates.io
  - .docker.io
```

Use a leading dot to match the domain and all subdomains.

### How It Works

When you run `moat`, the launcher:
1. If no `.moat.yml` exists, scans dependency files and offers to create one (`lib/detect.mjs` + `lib/init-config.mjs`)
2. Reads `<workspace>/.moat.yml` (`lib/compose.mjs`)
3. Generates `docker-compose.services.yml` with sidecar services on the sandbox network
4. Generates `squid-runtime.conf` with base domains + project-specific domains
5. Starts everything via `devcontainer up`

If no `.moat.yml` exists and the user declines auto-detection (or no services are detected), empty placeholders are generated (no-op).

See `moat.example.yml` in the repo for a fully documented example.

## Adding New Domains

Edit `squid.conf` in the repo and add:

```
acl allowed_domains dstdomain .example.com
```

Then restart the squid container (or just re-run `moat` — it rebuilds automatically).

Note: Use a leading dot (`.example.com`) to match the domain and all subdomains. Squid 6 does not allow both `example.com` and `.example.com` in the same ACL — the dot form covers both.

## Plan Mode

`moat plan` launches Claude with `--allowedTools "Read,Grep,Glob,Task,WebFetch,WebSearch"` — only read-only tools. This prevents Claude from writing files, running commands, or making edits during planning/research phases.

## Container Reuse

Containers persist across sessions for fast re-launch:
- On exit, the process exit handler kills the tool proxy and terminates Mutagen sync sessions, but **leaves the container running**
- On next launch, the container is reused if the workspace and `--add-dir` mounts match
- If the workspace or extra directories changed, the container is automatically recreated
- **Persistent volumes** (`moat-bashhistory`, `moat-config`) survive even full teardowns — bash history and Claude config carry over
- Use `moat down` to explicitly tear down containers

## Resource Limits

Set in `docker-compose.yml` via `deploy.resources.limits`:

| Service | CPUs | Memory |
|---------|------|--------|
| devcontainer | 4 | 8GB |
| squid | 0.5 | 256MB |

## Security Properties

| Layer | Mechanism | What it prevents |
|-------|-----------|-----------------|
| Docker network (`internal: true`) | No external routing for the devcontainer | Direct connections bypassing the proxy |
| Squid proxy ACLs | Domain whitelist, deny all else | Access to non-whitelisted domains |
| CONNECT restriction | `http_access deny CONNECT !SSL_ports` | Tunneling to arbitrary ports via CONNECT |
| No external DNS | Internal network blocks DNS to external resolvers | DNS-based data exfiltration |
| Git HTTPS rewrite | `git config url.insteadOf` | SSH connections (can't traverse HTTP proxy) |
| Tool proxy | Credentials stay on host, static bearer token auth, binds `127.0.0.1` only | Credential leakage into container |
| CLI wrappers | Shadow real git/gh binaries | Container accessing git/gh with host credentials directly |
| Non-root user | Runs as `node` user | Privilege escalation |
| No NET_ADMIN/NET_RAW | Capabilities not granted | Kernel-level network manipulation |
| Resource limits | CPU/memory caps via docker-compose | Resource exhaustion on host |
| Container reuse with rebuild | Recreated when workspace/mounts change | Stale state from previous workspace |
| Plan mode | Read-only tool restrictions | Unintended writes during research/planning |
| Podman (rootless, daemonless) | No host socket, containers inherit squid, no host filesystem access | Docker escape, network bypass |

## Docker Access (Podman)

When `docker: true` is set in `.moat.yml`, Docker commands are available inside the sandbox via rootless [Podman](https://podman.io/).

### Why Podman, not a Docker socket proxy

A Docker socket proxy (mounting `/var/run/docker.sock`) was considered and rejected because containers created through the host daemon land on the host's bridge network, **bypassing squid entirely**. This defeats moat's core network isolation. API-level filtering (blocking privileged containers, bind mounts, etc.) is insufficient — Docker Compose requires `NETWORKS=1`, and any container on a host-managed network has unrestricted egress.

Podman solves this architecturally: it's daemonless and runs containers as **child processes of the devcontainer**. All container traffic inherits the sandbox network and goes through squid. No host socket is exposed.

### Architecture

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

### How it works

1. `lib/compose.mjs` generates `docker-compose.docker.yml` — a compose overlay that adds `/dev/fuse` (for fuse-overlayfs storage driver), `seccomp=unconfined` + `apparmor=unconfined` (so Podman can create user namespaces), and `userns_mode: host` (opts out of Docker's user namespace remapping so `newuidmap` works)
2. `moat.mjs` includes this overlay in the `dockerComposeFile` array when `meta.has_docker` is true
3. Docker Hub domains (`.docker.io`, `.docker.com`, `production.cloudflare.docker.com`) and OS package repos (`.debian.org`, `.ubuntu.com`, `.alpinelinux.org`) are auto-added to the squid whitelist
4. Inside the container, `docker` is a wrapper that routes to `podman` (and `docker compose` to `podman-compose`)

### What works

```bash
docker build -t myapp .              # Build images from Dockerfiles
docker run myapp                     # Run a container
docker run -d -p 8080:80 nginx       # Detached with port mapping
docker compose up                    # Start services (via podman-compose)
docker compose down                  # Stop services
docker images / docker ps            # List images/containers
docker logs / docker stop / docker rm
docker volume ls / docker network ls
docker info                          # Engine info
```

Volume mounts within the container work:
```bash
docker run -v mydata:/data myapp           # Named volume
docker run --tmpfs /tmp myapp              # tmpfs
docker run -v ./src:/app myapp             # Bind mount from workspace
```

### Adding registry and package domains

All traffic goes through squid, so additional domains may be needed for Dockerfiles:

```yaml
# .moat.yml
docker: true
domains:
  - .ghcr.io              # GitHub Container Registry
  - .quay.io              # Red Hat Quay
  - .gcr.io               # Google Container Registry
  - .crates.io            # Rust packages
```

### Security properties

| Property | Status |
|----------|--------|
| Squid domain whitelist on `docker run` | **Enforced** — traffic goes through sandbox network |
| Squid domain whitelist on `docker build` | **Enforced** — builds happen inside the container |
| Host Docker socket exposure | **None** — Podman is daemonless |
| Host filesystem access | **None** — no connection to host daemon |
| Host container visibility | **None** — Podman sees only its own containers |
| Resource limits | **Bounded by devcontainer limits** (4 CPUs, 8GB) |

### Trade-offs

- **seccomp=unconfined + apparmor=unconfined**: Disables Docker's default syscall filter and AppArmor profile so Podman can create user namespaces (`CLONE_NEWUSER`). Mitigated by capability restrictions (no `CAP_SYS_ADMIN`) and network isolation
- **userns_mode: host**: Opts out of Docker's user namespace remapping so rootless Podman's `newuidmap` can map subordinate UIDs. The container still runs as non-root (uid 1000)
- **Build cache is ephemeral**: `moat down` destroys all cached images/layers. Images persist across `moat` sessions as long as the container isn't destroyed
- **podman-compose**: Handles most docker-compose.yml features but may differ from Docker Compose on edge cases (deploy configs, some network modes)

## Comparison to Previous iptables Approach

| Aspect | iptables (old) | Squid proxy (new) |
|--------|---------------|-------------------|
| Apple Silicon | Broken (no kernel netfilter under Rosetta) | Works (squid runs ARM64 native) |
| Filtering level | IP addresses (resolved at startup) | Domain names (resolved per-request) |
| Startup dependencies | Fetched GitHub IP ranges from API, resolved domains via dig | None — domains are static in config |
| Root required | Yes (iptables needs NET_ADMIN) | No |
| Bypass resistance | Process could bypass if iptables rules were wrong | Two layers: proxy ACLs + network isolation |
| Configuration | 140-line bash script | 47-line squid.conf |
| IP change handling | Fragile (IPs resolved once at startup) | Robust (squid resolves per-request) |

## Troubleshooting

### Claude Code can't connect to Anthropic

Add the missing domain to `squid.conf`. Known required domains:
- `.anthropic.com` (API)
- `.claude.ai` and `.claude.com` (platform)
- `.statsig.com` (feature flags)
- `.sentry.io` (error tracking)

### Squid container unhealthy

Check logs: `docker logs moat-squid-1`

Common issues:
- **Duplicate domain entries**: Squid 6 rejects both `example.com` and `.example.com` in the same ACL. Use only the dot form.
- **Log path permissions**: Use `access_log none` or a writable path. Squid's `proxy` user can't write to `/dev/stdout`.

### npm install fails

Ensure `.npmjs.org` is in the whitelist. npm respects `HTTPS_PROXY` natively.

### git clone fails

Git is configured to use HTTPS instead of SSH. If cloning from a non-GitHub host, add that domain to `squid.conf`.

### Tool proxy not reachable from container

If wrapper scripts show `Tool proxy unreachable`, check:
1. Is the proxy running on the host? `curl http://127.0.0.1:9876/health` should return `{"success":true}`
2. Is Docker Desktop running? The `host.docker.internal` gateway requires it
3. Is `host.docker.internal` in `squid.conf`? The container reaches the proxy through squid
4. Check proxy logs: `cat /tmp/claude-tool-proxy.log`

## Verification

From inside the container, test the sandbox:

```bash
# Allowed domains (should succeed)
curl https://api.github.com/zen
curl https://registry.npmjs.org/lodash
curl https://api.anthropic.com/

# Blocked domains (should fail with 403 from proxy)
curl https://example.com
curl https://google.com

# Direct bypass (should fail with network unreachable)
curl --noproxy '*' https://example.com

# Git via tool proxy (should work — routed to host)
cd /workspace && git status

# Git direct (outside /workspace — uses real git)
cd /tmp && git --version

# GH via tool proxy
gh auth status

# Tool proxy health (from inside container, through squid)
curl http://host.docker.internal:9876/health
```

## Known Gotchas

### jq NUL-byte argument serialization

The wrapper scripts serialize command arguments to JSON using NUL-delimited printf piped to jq:

```bash
ARGS_JSON=$(printf '%s\0' "$@" | jq -Rs '[split("\u0000")[] | select(length > 0)]')
```

**Bug found and fixed**: The original implementation used `split("\u0000") | .[:-1]` (trim last element) to remove a trailing empty string from the NUL-delimited split. However, jq 1.6 does NOT produce a trailing empty string when the input ends with a NUL byte — `printf '%s\0' status | jq -Rs 'split("\u0000")'` yields `["status"]`, not `["status", ""]`. The `.[:-1]` was therefore stripping the last *real* argument:

- `git status` → args sent as `[]` (empty) → got git help text instead
- `git log --oneline -3` → args sent as `["log", "--oneline"]` → missing `-3`
- `gh auth status` → args sent as `["auth"]` → got gh auth help instead

**Fix**: Use `[split("\u0000")[] | select(length > 0)]` which filters empty strings regardless of whether jq produces them, making it robust across jq versions.

### devcontainer CLI limitations

The `devcontainer` CLI has several limitations when composing with docker-compose:

- Does not forward host shell environment variables to docker-compose
- Does not read `.env` files next to docker-compose.yml
- Does not support `env_file` object syntax (`path:`, `required:`)
- `remoteEnv` variables are only available to `devcontainer exec` processes, not to child processes spawned by applications inside the container

These limitations are why the tool proxy uses a **static token baked into the Docker image** and **hardcoded proxy URL** instead of passing config via environment variables. Only `ANTHROPIC_API_KEY` is passed via `remoteEnv` (acceptable since Claude Code is the `devcontainer exec` process itself).

### Squid HTML error pages break wrapper scripts

When the tool proxy is down, squid returns a 503 HTML error page instead of a JSON response. If the wrapper scripts blindly pipe this into `jq`, you get cryptic parse errors like `Invalid numeric literal at line 1, column 10`.

**Fix**: Wrapper scripts validate the response is JSON before parsing: `if ! echo "$RESPONSE" | jq -e '.exitCode' >/dev/null 2>&1`. On failure, they show a clean one-line error: `[git-proxy] ERROR: Tool proxy unreachable or returned invalid response`.

### zsh job control kills background proxy (historical)

Background processes started in zsh functions (`node proxy.mjs &`) are unreliable — the proxy frequently dies or never starts. This was originally a problem when the launcher was a bash script managing background processes directly.

**Fix**: The launcher is now a directly executable Node.js program (`moat.mjs`) that manages the proxy via `child_process.spawn()` with proper lifecycle handling. No bash involved.
