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

# --- Helper: install via Homebrew if missing ---
brew_install() {
  local cmd=$1 pkg=$2
  if command -v "$cmd" &>/dev/null; then
    echo "PASS: $cmd already installed"
    return 0
  fi
  echo "INSTALLING: $cmd via brew..."
  brew install "$pkg"
  echo "PASS: $cmd installed"
}

# --- 1. Install prerequisites ---
echo "--- Installing prerequisites ---"

# Homebrew
if ! command -v brew &>/dev/null; then
  echo "INSTALLING: Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for the rest of this script
  if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -f /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  echo "PASS: Homebrew installed"
else
  echo "PASS: Homebrew already installed"
fi

# Docker Desktop
if ! command -v docker &>/dev/null; then
  echo "INSTALLING: Docker Desktop via brew..."
  brew install --cask docker
  echo "PASS: Docker Desktop installed"
  echo ""
  echo ">>> Please launch Docker Desktop from Applications and wait for it to start."
  echo ">>> Press Enter when Docker is running..."
  read -r
fi
# Wait for Docker daemon
if ! docker info &>/dev/null 2>&1; then
  echo "Waiting for Docker daemon..."
  for i in $(seq 1 30); do
    if docker info &>/dev/null 2>&1; then
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "FAIL: Docker daemon not responding after 30s. Launch Docker Desktop and re-run."
      exit 1
    fi
    sleep 1
  done
fi
echo "PASS: Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"

# Node.js
brew_install node node

# devcontainer CLI
if ! command -v devcontainer &>/dev/null; then
  echo "INSTALLING: devcontainer CLI..."
  npm install -g @devcontainers/cli
  echo "PASS: devcontainer CLI installed"
else
  echo "PASS: devcontainer CLI already installed"
fi

# GitHub CLI
brew_install gh gh
if ! gh auth status &>/dev/null 2>&1; then
  echo "WARN: gh not authenticated. Run: gh auth login"
fi

# IaC tools
brew_install terraform hashicorp/tap/terraform
brew_install kubectl kubectl
brew_install aws awscli

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
for f in devcontainer.json docker-compose.yml docker-compose.extra-dirs.yml \
         Dockerfile squid.conf tool-proxy.mjs anvil.sh verify.sh \
         git-proxy-wrapper.sh gh-proxy-wrapper.sh \
         terraform-proxy-wrapper.sh kubectl-proxy-wrapper.sh aws-proxy-wrapper.sh \
         auto-diagnostics.sh ide-tools.mjs ide-lsp.mjs; do
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
  -f "$HOME_CONFIG_DIR/docker-compose.yml" \
  -f "$HOME_CONFIG_DIR/docker-compose.extra-dirs.yml" build

echo ""
echo "PASS: Docker image built"

echo ""
echo "=============================="
echo "Setup complete!"
echo "=============================="
echo ""
echo "Usage:"
echo "  anvil                                    # Full access (default: cwd)"
echo "  anvil ~/Projects/myapp                  # Target a specific repo"
echo "  anvil . --add-dir ~/Projects/shared-lib # Mount extra directories"
echo "  anvil-plan                              # Read-only tools only"
echo ""
echo "You may need to restart your shell for aliases to take effect:"
echo "  source $SHELL_RC"
echo ""
