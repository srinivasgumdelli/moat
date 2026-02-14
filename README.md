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
```

**Diagnose** setup issues:

```bash
moat doctor
```

**Update** (pulls latest code + rebuilds the Docker image):

```bash
moat update
```

Extra directories are mounted at `/extra/<dirname>` inside the container and automatically registered with Claude Code via `--add-dir`.

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| Docker Desktop | Yes | https://docker.com/products/docker-desktop |
| Node.js | Yes | `brew install node` |
| gh CLI | Optional | `brew install gh && gh auth login` |
| terraform | Optional | `brew install terraform` (on host, for proxy) |
| kubectl | Optional | `brew install kubectl` (on host, for proxy) |
| aws CLI | Optional | `brew install awscli` (on host, for proxy) |

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
| Ephemeral containers | Persistent compromise |

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

## Adding domains to the whitelist

Edit `squid.conf` and add:

```
acl allowed_domains dstdomain .example.com
```

Then re-run `moat` (the container rebuilds automatically).

## Project structure

```
moat/
├── moat.sh                    # Launcher (starts proxy, container, Claude)
├── install.sh                  # Unified installer (curl-pipeable, auto-detects context)
├── tool-proxy.mjs              # Host-side proxy server with allowlists
├── Dockerfile                  # Container image
├── docker-compose.yml          # squid + devcontainer services
├── docker-compose.extra-dirs.yml # Extra directory mounts (auto-generated)
├── devcontainer.json           # devcontainer CLI config
├── squid.conf                  # Domain whitelist
├── test.sh                     # End-to-end test suite
├── verify.sh                   # Post-start verification
├── git-proxy-wrapper.sh        # Container-side git wrapper
├── gh-proxy-wrapper.sh         # Container-side gh wrapper
├── terraform-proxy-wrapper.sh  # Container-side terraform wrapper
├── kubectl-proxy-wrapper.sh    # Container-side kubectl wrapper
├── aws-proxy-wrapper.sh        # Container-side aws wrapper
├── auto-diagnostics.sh         # PostToolUse hook for linting after edits
├── ide-tools.mjs               # MCP server: diagnostics, tests, project info
├── ide-lsp.mjs                 # MCP server: LSP code intelligence
└── docs/
    ├── setup.md                # Detailed setup guide
    ├── project-plan.md         # Roadmap and architecture decisions
    ├── architecture.md         # Original squid proxy design
    └── ideas.md                # Future IDE features
```

