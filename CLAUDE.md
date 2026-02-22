# Moat — Project Development Instructions

These are instructions for working on the Moat codebase itself.

## Architecture
- `moat.mjs` — entry point: argument routing, main flow, cleanup
- `lib/` — module per concern (cli, compose, container, proxy, etc.)
- `tool-proxy.mjs` — host-side proxy server with IaC allowlists
- Container image built from `Dockerfile` with squid proxy for network isolation

## Testing
- `test.sh` — end-to-end test suite (run from host)
- `verify.sh` — post-start verification (runs inside container)

## Conventions
- Pure ESM (`.mjs` extension, `import`/`export`)
- No build step — scripts run directly with Node
- Prefer `runCapture` / `runInherit` from `lib/exec.mjs` over raw `child_process`
