# Replace iptables Firewall with Squid Proxy Sandbox

## Context

The devcontainer at `/Users/sri/.devcontainers/anvil/` uses iptables rules to restrict outbound network access. This fails on Apple Silicon because iptables (legacy and nft) doesn't work under Rosetta x86_64 emulation. We're replacing it with Docker network isolation + a squid forward proxy sidecar.

## Architecture

```
              External Network (extnet)
                    |
               [squid:3128]     (ARM64 native, no emulation)
                    |
          Internal Network (sandbox, internal: true)
                    |
              [devcontainer]    (amd64 under Rosetta)
              HTTP_PROXY=http://squid:3128
```

- Devcontainer is ONLY on the `internal: true` network (zero direct external access)
- Squid bridges both networks, enforcing domain whitelist via ACLs
- Even processes ignoring proxy env vars can't reach the internet (fail-closed)

## File Changes

| Action | File | Description |
|--------|------|-------------|
| Create | `docker-compose.yml` | Two services (squid + devcontainer) with isolated network |
| Create | `squid.conf` | Domain whitelist ACLs |
| Create | `verify-sandbox.sh` | Post-start verification (replaces firewall verification) |
| Modify | `Dockerfile` | Remove firewall packages, add git HTTPS config |
| Modify | `devcontainer.json` | Switch from `build` to `dockerComposeFile` |
| Delete | `init-firewall.sh` | Replaced by squid config |

All files in `/Users/sri/.devcontainers/anvil/`.

## Step 1: Create `docker-compose.yml`

Two services:
- **squid**: `ubuntu/squid:latest` (ARM64 native), on both `sandbox` and `extnet` networks, healthcheck via `squid -k check`
- **devcontainer**: Builds from Dockerfile, ONLY on `sandbox` network, depends on squid healthy, sets `HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy` + `NO_PROXY` + existing env vars (`NODE_OPTIONS`, `CLAUDE_CONFIG_DIR`, `DEVCONTAINER`)

Networks:
- `sandbox`: `internal: true` (no external access)
- `extnet`: default bridge (external access)

Volumes: `anvil-bashhistory`, `anvil-config` (compose manages naming)

## Step 2: Create `squid.conf`

Whitelist domains (matching current `init-firewall.sh`):
- `.github.com`, `.githubusercontent.com`, `.githubassets.com`
- `.npmjs.org`, `registry.npmjs.org`
- `.anthropic.com`, `api.anthropic.com`
- `sentry.io`, `.sentry.io`
- `statsig.anthropic.com`, `.statsig.com`
- `marketplace.visualstudio.com`, `vscode.blob.core.windows.net`, `update.code.visualstudio.com`, `.vo.msecnd.net`, `.gallerycdn.vsassets.io`
- `claude.ai`, `.claude.ai`

Rules: deny CONNECT to non-SSL ports, allow whitelisted domains, deny all else. Log to stdout/stderr. No caching.

## Step 3: Create `verify-sandbox.sh`

Checks (runs as `codespace`, no sudo needed):
1. `HTTPS_PROXY` env var is set
2. Allowed domain reachable through proxy (api.github.com)
3. Blocked domain denied by proxy (example.com)
4. Direct access bypassing proxy blocked (network isolation)
5. Git HTTPS rewrite configured

## Step 4: Modify `Dockerfile`

Remove:
- `apt-get install iptables ipset iproute2 dnsutils aggregate` (and the yarn GPG fix RUN before it)
- `COPY init-firewall.sh` + sudoers config

Add:
- `git config --global url."https://github.com/".insteadOf "git@github.com:"` (force HTTPS, SSH can't traverse HTTP proxy)
- `git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"`
- `COPY verify-sandbox.sh`

Keep: yarn GPG fix, bash history, claude config dir, git-delta, claude-code npm install

## Step 5: Modify `devcontainer.json`

- Replace `build` with `dockerComposeFile: "docker-compose.yml"` + `service: "devcontainer"`
- Remove: `runArgs` (NET_ADMIN/NET_RAW no longer needed), `workspaceMount`, `mounts`, `containerEnv` (moved to compose)
- Keep: `remoteEnv` with `ANTHROPIC_API_KEY` (`${localEnv:...}` only works in devcontainer.json)
- Change `postStartCommand` to `verify-sandbox.sh` (no sudo)

## Step 6: Delete `init-firewall.sh`

## Verification

After rebuild, test inside the container:
```bash
curl https://api.github.com/zen              # Should work
curl https://registry.npmjs.org/lodash       # Should work
curl https://example.com                     # Should fail (proxy denies)
curl --noproxy '*' https://example.com       # Should fail (network isolation)
git clone https://github.com/octocat/Hello-World  # Should work
```
