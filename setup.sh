#!/bin/bash
# Anvil — One-command setup
# Usage: ./setup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_CONFIG_DIR="$HOME/.devcontainers/anvil"

echo "=============================="
echo "Anvil Setup"
echo "=============================="
echo ""

# --- 1. Check prerequisites ---
echo "--- Checking prerequisites ---"

MISSING=0

if ! command -v docker &>/dev/null; then
  echo "FAIL: Docker not found. Install Docker Desktop: https://docker.com/products/docker-desktop"
  MISSING=1
elif ! docker info &>/dev/null 2>&1; then
  echo "FAIL: Docker is not running. Start Docker Desktop first."
  MISSING=1
else
  echo "PASS: Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
fi

if ! command -v node &>/dev/null; then
  echo "FAIL: Node.js not found. Install: brew install node"
  MISSING=1
else
  echo "PASS: Node.js $(node --version)"
fi

if ! command -v devcontainer &>/dev/null; then
  echo "INFO: devcontainer CLI not found, installing..."
  npm install -g @devcontainers/cli
  echo "PASS: devcontainer CLI installed"
else
  echo "PASS: devcontainer CLI $(devcontainer --version 2>/dev/null || echo 'installed')"
fi

if command -v gh &>/dev/null; then
  echo "PASS: GitHub CLI (gh) installed"
  if gh auth status &>/dev/null 2>&1; then
    echo "PASS: gh authenticated"
  else
    echo "WARN: gh not authenticated. Run: gh auth login"
  fi
else
  echo "WARN: GitHub CLI (gh) not found. Git/gh proxy won't work. Install: brew install gh"
fi

# Optional: check IaC tools on host
for tool in terraform kubectl aws; do
  if command -v "$tool" &>/dev/null; then
    echo "PASS: $tool available on host (for proxy)"
  else
    echo "INFO: $tool not on host — proxy for $tool will fail (install if needed)"
  fi
done

if [ $MISSING -ne 0 ]; then
  echo ""
  echo "Required tools missing. Fix the FAIL items above and re-run."
  exit 1
fi

echo ""

# --- 2. Install configuration ---
echo "--- Installing configuration ---"

if [ ! -d "$REPO_DIR" ]; then
  echo "ERROR: Config not found at $REPO_DIR"
  echo "Run this script from the repo root."
  exit 1
fi

mkdir -p "$HOME_CONFIG_DIR"

# Copy all config files
for f in devcontainer.json docker-compose.yml Dockerfile squid.conf \
         tool-proxy.mjs anvil.sh verify-sandbox.sh \
         git-proxy-wrapper.sh gh-proxy-wrapper.sh \
         terraform-proxy-wrapper.sh kubectl-proxy-wrapper.sh aws-proxy-wrapper.sh; do
  if [ -f "$REPO_DIR/$f" ]; then
    cp "$REPO_DIR/$f" "$HOME_CONFIG_DIR/$f"
  fi
done

# Make scripts executable
chmod +x "$HOME_CONFIG_DIR"/*.sh "$HOME_CONFIG_DIR"/*.mjs 2>/dev/null || true
echo "PASS: Config installed to $HOME_CONFIG_DIR"

echo ""

# --- 3. Generate proxy token ---
echo "--- Proxy token ---"

TOKEN_FILE="$HOME_CONFIG_DIR/.proxy-token"
if [ -f "$TOKEN_FILE" ]; then
  echo "PASS: Proxy token already exists"
else
  openssl rand -hex 32 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "PASS: Proxy token generated at $TOKEN_FILE"
fi

echo ""

# --- 4. Configure shell aliases ---
echo "--- Shell configuration ---"

# Detect shell rc file
if [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
else
  SHELL_RC="$HOME/.profile"
fi

if grep -q "alias anvil=" "$SHELL_RC" 2>/dev/null; then
  echo "PASS: Shell aliases already in $SHELL_RC"
else
  cat >> "$SHELL_RC" << 'ALIASES'

# Anvil — sandboxed Claude Code
alias anvil='~/.devcontainers/anvil/anvil.sh'
alias anvil-plan='~/.devcontainers/anvil/anvil.sh --allowedTools "Read,Grep,Glob,Task,WebFetch,WebSearch"'
ALIASES
  echo "PASS: Aliases added to $SHELL_RC"
fi

echo ""

# --- 5. Check ANTHROPIC_API_KEY ---
echo "--- API key ---"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "PASS: ANTHROPIC_API_KEY is set"
else
  echo "WARN: ANTHROPIC_API_KEY not set in environment"
  echo "      Add to your shell profile: export ANTHROPIC_API_KEY=sk-ant-..."
fi

echo ""

# --- 6. Build Docker image ---
echo "--- Building Docker image ---"
echo "This may take 5-10 minutes on first run (cached after that)..."
echo ""

docker compose --project-name anvil \
  -f "$HOME_CONFIG_DIR/docker-compose.yml" build

echo ""
echo "PASS: Docker image built"

echo ""
echo "=============================="
echo "Setup complete!"
echo "=============================="
echo ""
echo "Usage:"
echo "  anvil           # Full sandbox with all tools"
echo "  anvil-plan      # Plan mode (read-only tools only)"
echo ""
echo "You may need to restart your shell for aliases to take effect:"
echo "  source $SHELL_RC"
echo ""
