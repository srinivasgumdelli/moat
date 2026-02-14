# Moat — Project Plan

## Context

The sandboxed devcontainer gives Claude Code file access, bash, git/gh (via proxy), and web search. We're extending it in three phases: (1) IaC tool proxying with security controls, (2) a one-command setup script, and (3) IDE-level capabilities via MCP servers and hooks. Terraform/IaC is the top priority.

---

## Phase 1: IaC Tool Proxying

### Architecture

Same pattern as git/gh — wrapper scripts in the container proxy commands to the host-side `tool-proxy.mjs`, which has the cloud credentials. Credentials never enter the container.

```
Container                          Host (tool-proxy.mjs :9876)
─────────                          ──────────────────────────
/usr/local/bin/terraform  ──POST /terraform──>  terraform (has ~/.aws, ~/.config/gcloud, etc.)
/usr/local/bin/kubectl    ──POST /kubectl────>  kubectl   (has ~/.kube/config)
/usr/local/bin/aws        ──POST /aws────────>  aws       (has AWS_* env vars)
                          (via squid)
```

**Credential pass-through**: The proxy inherits the host's full environment (`{ ...process.env }` in spawn options). Whatever cloud credentials exist on the host (AWS_*, GOOGLE_*, ARM_*, KUBECONFIG, etc.) are available to proxied commands. No provider-specific logic needed — works with any cloud.

### Terraform Safety: Plan-Only Allowlist

Claude can analyze, plan, and validate — but never mutate infrastructure.

**Allowed** (read-only / safe):
```
init, plan, validate, fmt, show, output, graph, providers,
version, workspace list, workspace show, workspace select,
state list, state show, state pull, console
```

**Blocked** (mutates infrastructure or state):
```
apply, destroy, taint, untaint, import, refresh,
state rm, state mv, state push, state replace-provider,
force-unlock
```

Implementation: The proxy checks `args[0]` (subcommand) against the allowlist before executing. Returns `{ success: false, blocked: true, reason: "terraform apply is not allowed in sandbox mode" }`.

### kubectl/aws Safety

**kubectl allowlist**: `get, describe, logs, top, api-resources, api-versions, cluster-info, config view, config get-contexts, config current-context, version, auth can-i, diff, explain`

**kubectl blocked**: `apply, delete, create, patch, replace, scale, rollout, edit, exec, cp, drain, cordon, uncordon, taint, label, annotate` (anything that mutates)

**aws**: Allowlist approach — only `sts get-caller-identity`, `s3 ls`, `s3 cp` (download only), and `describe-*`/`list-*`/`get-*` subcommands for any service. Block `create-*`, `delete-*`, `terminate-*`, `remove-*`, `put-*`, `update-*`, `run-*`.

### Files to Create

All in the repo (symlinked from `~/.devcontainers/moat/`):

| File | Purpose |
|------|---------|
| `terraform-proxy-wrapper.sh` | Container wrapper at `/usr/local/bin/terraform` |
| `kubectl-proxy-wrapper.sh` | Container wrapper at `/usr/local/bin/kubectl` |
| `aws-proxy-wrapper.sh` | Container wrapper at `/usr/local/bin/aws` |

### Files to Modify

| File | Changes |
|------|---------|
| `tool-proxy.mjs` | Add `/terraform`, `/kubectl`, `/aws` endpoints with allowlists |
| `Dockerfile` | Install terraform, kubectl, aws-cli; COPY wrapper scripts |
| `squid.conf` | Add registry.terraform.io, releases.hashicorp.com for `terraform init` provider downloads at runtime |
| `verify-sandbox.sh` | Add terraform/kubectl/aws proxy checks |

### tool-proxy.mjs Changes

Add three new endpoints following the existing git/gh pattern. Key addition is the allowlist validator:

```javascript
// Allowlist configuration per tool
const ALLOWLISTS = {
  terraform: new Set([
    'init', 'plan', 'validate', 'fmt', 'show', 'output', 'graph',
    'providers', 'version', 'workspace', 'state', 'console'
  ]),
  // For terraform state, further restrict: only list/show/pull
  terraformState: new Set(['list', 'show', 'pull']),
  // For terraform workspace, further restrict: only list/show/select
  terraformWorkspace: new Set(['list', 'show', 'select']),
};

function validateTerraform(args) {
  const subcmd = args[0];
  if (!ALLOWLISTS.terraform.has(subcmd)) {
    return { allowed: false, reason: `terraform ${subcmd} is blocked in sandbox (plan-only mode)` };
  }
  // Sub-subcommand validation for state and workspace
  if (subcmd === 'state' && args[1] && !ALLOWLISTS.terraformState.has(args[1])) {
    return { allowed: false, reason: `terraform state ${args[1]} is blocked` };
  }
  if (subcmd === 'workspace' && args[1] && !ALLOWLISTS.terraformWorkspace.has(args[1])) {
    return { allowed: false, reason: `terraform workspace ${args[1]} is blocked` };
  }
  return { allowed: true };
}
```

Each endpoint: parse body → validate against allowlist → translate cwd → execute → return result. Same `executeCommand()` function, same response format.

For kubectl/aws, same pattern with their respective allowlists.

### Wrapper Script Pattern

All three wrappers follow the exact same pattern as `git-proxy-wrapper.sh`:

```bash
#!/bin/bash
PROXY_URL="http://host.docker.internal:9876"
PROXY_TOKEN=$(cat /etc/tool-proxy-token 2>/dev/null)
CWD="$(pwd)"

# For terraform: only proxy in /workspace, fallback to real binary elsewhere
# For kubectl/aws: always proxy (they always need credentials)

# Serialize args, POST to proxy, validate JSON response, output result
# Same jq serialization: printf '%s\0' "$@" | jq -Rs '[split("\u0000")[] | select(length > 0)]'
# Same error handling: check for valid JSON, clean error on proxy down
# NEW: check for .blocked in response → print reason and exit 126
```

The terraform wrapper has smart routing (like git): proxy in `/workspace`, real terraform elsewhere. kubectl and aws always proxy (like gh).

### Dockerfile Additions

```dockerfile
# Install Terraform
RUN wget -qO- https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/hashicorp.gpg arch=amd64] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/hashicorp.list && \
    apt-get update && apt-get install -y terraform && rm -rf /var/lib/apt/lists/*

# Install kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/kubectl.real

# Install AWS CLI v2
RUN curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip && \
    unzip -q awscliv2.zip && ./aws/install && rm -rf awscliv2.zip aws/

# Copy IaC proxy wrappers (shadow real binaries)
COPY terraform-proxy-wrapper.sh /usr/local/bin/terraform
COPY kubectl-proxy-wrapper.sh /usr/local/bin/kubectl
COPY aws-proxy-wrapper.sh /usr/local/bin/aws
RUN chmod +x /usr/local/bin/terraform /usr/local/bin/kubectl /usr/local/bin/aws
```

Note: `terraform` is installed to `/usr/bin/terraform` by apt, our wrapper at `/usr/local/bin/terraform` shadows it. kubectl real binary saved as `kubectl.real`. AWS CLI installs to `/usr/local/bin/aws`, so we overwrite it (real binary at `/usr/local/aws-cli/v2/current/bin/aws`).

### squid.conf Additions

```
# Terraform (provider downloads during terraform init)
acl allowed_domains dstdomain .registry.terraform.io
acl allowed_domains dstdomain .releases.hashicorp.com
acl allowed_domains dstdomain .checkpoint-api.hashicorp.com
```

Note: `terraform init` runs on the HOST via the proxy, using the host's unrestricted network. These squid rules are only needed if terraform is also installed in the container for local validation (e.g., `terraform fmt` on non-workspace files). For the proxied workflow, squid doesn't need these. Adding them is belt-and-suspenders.

AWS/GCP/Azure API domains are NOT added to squid — cloud API calls happen on the host side via the proxy, not from the container.

---

## Phase 2: Setup Script

### Install options

**Full setup** (installs prerequisites via Homebrew):
```bash
git clone ... && cd moat && ./setup.sh
```

**Curl installer** (assumes Docker, Node, git already installed):
```bash
curl -fsSL https://raw.githubusercontent.com/srinivasgumdelli/moat/main/install.sh | bash
```

**Update** (one command):
```bash
moat update
```

### What `setup.sh` Does

```
1. Check/install prerequisites
   ├── Homebrew, Docker Desktop, Node.js (via brew)
   ├── devcontainer CLI (npm install -g)
   ├── gh CLI, terraform, kubectl, aws (via brew)
   └── Warn if ANTHROPIC_API_KEY not set

2. Link configuration
   ├── Migrate old directory-based installs (preserve .proxy-token)
   ├── Create symlink: ~/.devcontainers/moat/ → repo dir
   └── No file copying — repo is used directly

3. Generate proxy token
   ├── If ~/.moat/data/.proxy-token exists → skip
   ├── Otherwise: openssl rand -hex 32, chmod 600
   └── Copy token into repo for Docker build context

4. Configure shell
   ├── Detect shell (zsh/bash)
   ├── If aliases already exist → skip
   └── Append moat aliases to shell rc

5. Build Docker image
   ├── docker compose build (uses host network, full internet access)
   └── First build is slow (~10 min), subsequent builds use cache
```

### What `install.sh` Does

Lightweight version — skips Homebrew/prerequisite installs:

```
1. Check prerequisites (git, docker, node) — error with instructions if missing
2. Install devcontainer CLI if missing
3. Clone repo to ~/.moat (or git pull if exists)
4. Create symlink ~/.devcontainers/moat/ → repo
5. Migrate old directory-based installs
6. Generate proxy token in ~/.moat/data/
7. Add shell aliases
8. Build Docker image
```

### Prerequisites Table

| Tool | Required | Install |
|------|----------|---------|
| Docker Desktop | Yes | https://docker.com/products/docker-desktop |
| Node.js | Yes | `brew install node` or https://nodejs.org |
| devcontainer CLI | Yes (auto-installed) | `npm install -g @devcontainers/cli` |
| gh CLI | Optional (for git/gh proxy) | `brew install gh` && `gh auth login` |
| terraform | Optional (for IaC proxy) | Installed in container; host needs it for proxy |
| kubectl | Optional (for k8s proxy) | Installed in container; host needs it for proxy |
| aws CLI | Optional (for AWS proxy) | Installed in container; host needs it for proxy |

---

## Phase 3: Security Architecture

### Threat Model

**What we're protecting against**: Claude Code running with `--dangerously-skip-permissions` having unrestricted access to credentials, network, and infrastructure.

**Trust boundaries**:
```
┌─ TRUSTED (host) ──────────────────────────────┐
│  Cloud credentials (~/.aws, ~/.kube, etc.)     │
│  GitHub tokens (gh auth)                       │
│  ANTHROPIC_API_KEY                             │
│  tool-proxy.mjs (enforces allowlists)          │
│  Host filesystem (~/Repos mounted read-write)  │
└────────────────────────────────────────────────┘
         │ HTTP via host.docker.internal:9876
         │ (bearer token auth, allowlist enforcement)
         │
┌─ SANDBOXED (container) ───────────────────────┐
│  Claude Code (--dangerously-skip-permissions)  │
│  Wrapper scripts (serialize & POST)            │
│  Squid proxy (domain whitelist)                │
│  Internal Docker network (no direct egress)    │
└────────────────────────────────────────────────┘
```

### Security Layers (12)

| # | Layer | What it prevents | Bypass difficulty |
|---|-------|-----------------|-------------------|
| 1 | Docker network (`internal: true`) | Direct outbound connections | Requires Docker escape |
| 2 | Squid domain whitelist | Accessing non-whitelisted domains | Would need to compromise squid |
| 3 | CONNECT restriction | Tunneling to arbitrary ports | Blocked at proxy level |
| 4 | No external DNS | DNS exfiltration | Internal network only |
| 5 | Tool proxy bearer token | Unauthorized proxy access | Token in image, but network blocks external access |
| 6 | Tool proxy allowlists | Destructive terraform/kubectl/aws commands | Enforced server-side on host |
| 7 | Git HTTPS rewrite | SSH connections (can't traverse HTTP proxy) | Configured in git global config |
| 8 | Credential isolation | Cloud creds, GitHub tokens entering container | Creds only exist on host; proxy mediates |
| 9 | Proxy binds 127.0.0.1 | Network-level proxy access | Only reachable via Docker Desktop gateway |
| 10 | Non-root user | Privilege escalation in container | Runs as `node` user |
| 11 | Resource limits | DoS / resource exhaustion | 4 CPU, 8GB RAM caps |
| 12 | Ephemeral containers | Persistent compromise | Torn down after each session |

### Credential Flow

```
Cloud credentials:
  Host: ~/.aws/credentials, ~/.kube/config, GOOGLE_APPLICATION_CREDENTIALS, etc.
    → tool-proxy.mjs inherits host env via process.env
    → spawn('terraform', args, { env: { ...process.env } })
    → terraform runs on host with full credentials
    → Only stdout/stderr/exitCode returned to container
  Container: NO cloud credentials. Ever.

GitHub tokens:
  Host: gh auth token → cached in tool-proxy.mjs (10 min TTL)
    → Injected as GITHUB_TOKEN env var for gh commands
  Container: NO GitHub tokens.

ANTHROPIC_API_KEY:
  Host → devcontainer.json remoteEnv → container
  This is the ONE credential that enters the container.
  Protected by: network isolation (can only reach anthropic.com through squid)

Proxy token (.proxy-token):
  Source of truth: ~/.moat/data/.proxy-token
  Copied into repo dir before Docker builds (in .gitignore)
  Baked into Docker image at /etc/tool-proxy-token
  tool-proxy.mjs reads via MOAT_TOKEN_FILE env var (fallback: __dirname/.proxy-token)
  Not a credential — it's an auth token for the local proxy
  Only useful from within the Docker network
```

### What Claude CAN Do (Even in Sandbox)

Things the sandbox does NOT prevent:
- Read/write files in ~/Repos (mounted workspace)
- Run arbitrary bash commands inside the container
- Make HTTP requests to whitelisted domains
- Install packages from whitelisted registries (npm, pip)
- Use cloud CLI tools in read-only mode (terraform plan, kubectl get, aws describe)

These are intentional — Claude needs these to be useful. The sandbox prevents:
- Accessing non-whitelisted domains
- Using cloud credentials to mutate infrastructure
- Exfiltrating data through unauthorized channels
- Accumulating persistent state (ephemeral containers)

### Audit Logging

The tool proxy logs every command to stderr (`/tmp/claude-tool-proxy.log`):
```
[tool-proxy] gh auth status -> exit 0
[tool-proxy] git status in ~/Repos/projects -> exit 0
[tool-proxy] terraform plan in ~/Repos/infra -> exit 0
[tool-proxy] terraform apply BLOCKED (plan-only mode)
[tool-proxy] kubectl get pods -> exit 0
[tool-proxy] kubectl delete BLOCKED (read-only mode)
```

---

## Phase 4: IDE Features (Implemented)

Three integration layers, each independently valuable:

### Phase 4a: Auto-Diagnostics Hook (done)

**File**: `auto-diagnostics.sh` → `/home/node/.claude/hooks/auto-diagnostics.sh`

Sync PostToolUse hook runs after every Edit/Write. Reads `tool_input.file_path` from stdin, runs the appropriate fast linter, and injects diagnostics via `additionalContext`:

| Extension | Linter | Notes |
|-----------|--------|-------|
| `.ts`, `.tsx`, `.js`, `.jsx` | project-local `eslint` | Only runs if `node_modules/.bin/eslint` exists |
| `.py` | `ruff check` | Installed globally in image |
| `.go` | `go vet` | Runs on package directory |

Registered in `settings.json` with matcher `Edit|Write`, 30s timeout.

### Phase 4b: ide-tools MCP Server (done)

**File**: `ide-tools.mjs` → `/home/node/.claude/mcp/ide-tools.mjs`

Stateless MCP server — each tool call spawns a subprocess, captures structured output, returns JSON.

| Tool | Description | Backend |
|------|-------------|---------|
| `run_diagnostics` | Full type-check/lint for a file or project | `tsc --noEmit`, `pyright --outputjson`, `golangci-lint run --out-format json` |
| `run_tests` | Run tests with structured JSON output | `vitest --reporter=json`, `pytest --json-report`, `go test -json` |
| `list_tests` | List available tests without running them | `vitest list`, `pytest --collect-only`, `go test -list` |
| `get_project_info` | Detect language, framework, test runner, build system | Reads `package.json`, `pyproject.toml`, `go.mod` |

Auto-detects language from file extension or project files. Auto-detects project root by walking up to find `package.json`, `go.mod`, etc.

### Phase 4c: ide-lsp MCP Server (done)

**File**: `ide-lsp.mjs` → `/home/node/.claude/mcp/ide-lsp.mjs`

MCP server managing persistent language server connections over stdio JSON-RPC with Content-Length framing.

| Tool | LSP Method |
|------|------------|
| `lsp_hover` | `textDocument/hover` |
| `lsp_definition` | `textDocument/definition` |
| `lsp_references` | `textDocument/references` |
| `lsp_diagnostics` | `textDocument/publishDiagnostics` (cached) |
| `lsp_symbols` | `textDocument/documentSymbol` |
| `lsp_workspace_symbols` | `workspace/symbol` |

Language servers start lazily on first tool call for that language, then persist for the MCP server's lifetime (= Claude session):

| Extension | Server | Command |
|-----------|--------|---------|
| `.ts`, `.tsx`, `.js`, `.jsx` | typescript-language-server | `typescript-language-server --stdio` |
| `.py` | pyright | `pyright-langserver --stdio` |
| `.go` | gopls | `gopls serve` |

File state is tracked per server — files are opened via `textDocument/didOpen` on first access, then updated via `textDocument/didChange` on subsequent calls.

### Installed tooling

Added to the Docker image (all three languages):

**As root (before Claude Code install):**
- Python 3 + `ruff` + `pyright` (via pip)
- Go 1.23.6 runtime

**As node (after Claude Code install):**
- `typescript`, `typescript-language-server` (npm global)
- `gopls` (go install)
- `golangci-lint` (install script)
- `@modelcontextprotocol/sdk`, `vscode-languageserver-protocol`, `vscode-jsonrpc` (npm global)

### Proxy domains added

`squid.conf` now allows PyPI (`.pypi.org`, `.pythonhosted.org`) and Go (`proxy.golang.org`, `sum.golang.org`, `storage.googleapis.com`) for runtime package installs.

### Future IDE work
- **playwright MCP**: Off-the-shelf `@playwright/mcp` for web preview, screenshots, DOM inspection
- **Per-project config**: `.claude/ide.yml` to configure language servers, services, and allowed domains
- **Background services**: Extend docker-compose for postgres, redis, etc.

---

## Implementation Order

| Step | What | Files |
|------|------|-------|
| 1 | Extend tool-proxy.mjs with /terraform, /kubectl, /aws + allowlists | `tool-proxy.mjs` |
| 2 | Create IaC wrapper scripts | `terraform-proxy-wrapper.sh`, `kubectl-proxy-wrapper.sh`, `aws-proxy-wrapper.sh` |
| 3 | Update Dockerfile to install terraform, kubectl, aws-cli + copy wrappers | `Dockerfile` |
| 4 | Update squid.conf with HashiCorp domains | `squid.conf` |
| 5 | Update verify-sandbox.sh with IaC checks | `verify-sandbox.sh` |
| 6 | Create setup.sh + install.sh | `setup.sh`, `install.sh` (repo root) |
| 7 | Update documentation | `docs/setup.md`, `docs/project-plan.md` |
| 8 | Test end-to-end: terraform plan, kubectl get, aws sts | Manual testing |

## Verification

1. `terraform version` inside container → proxied to host, returns version
2. `terraform init` in a workspace project → downloads providers via host network
3. `terraform plan` → runs on host with cloud credentials, returns plan output
4. `terraform apply` → **BLOCKED**, returns clear error message
5. `kubectl get pods` → proxied to host, returns pod list
6. `kubectl delete pod X` → **BLOCKED**
7. `aws sts get-caller-identity` → returns caller identity from host credentials
8. `aws ec2 terminate-instances` → **BLOCKED**
9. `./setup.sh` on a clean machine → installs everything, creates symlink, builds image, ready to run
10. `curl ... | bash` on machine with prereqs → clones repo, creates symlink, builds image
11. `moat update` → pulls latest code, rebuilds image

## Gotchas

- **terraform init needs host network**: Runs on host via proxy, not through squid. Works naturally.
- **terraform state backends**: S3/GCS/Azure storage accessed by terraform on the host — needs cloud credentials, which the host has.
- **Long-running commands**: `terraform plan` on large infra can take minutes. The proxy HTTP request will wait. Wrapper should not have a short curl timeout — use `--max-time 300` (5 min).
- **Path translation for -var-file**: If terraform references `-var-file=/workspace/vars.tfvars`, the proxy translates it. Need to scan args for file paths.
- **Wrapper shadows real binary**: If user needs real terraform in container for non-workspace use, wrapper must fallback (like git wrapper does).
- **AWS CLI v2 install path**: Installs to `/usr/local/bin/aws` by default, our wrapper overwrites this. Real binary at `/usr/local/aws-cli/v2/current/bin/aws`.
