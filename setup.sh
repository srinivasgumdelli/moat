#!/bin/bash
# Moat — One-command setup (with prerequisite installs)
# Usage: ./setup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SYMLINK_PATH="$HOME/.devcontainers/moat"
DATA_DIR="$HOME/.local/share/moat-data"

echo "=============================="
echo "Moat Setup"
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

# --- 2. Create symlink (replacing old copy-based install) ---
echo "--- Installing configuration ---"

mkdir -p "$(dirname "$SYMLINK_PATH")"
mkdir -p "$DATA_DIR"

# Migrate old directory-based installs
if [ -d "$SYMLINK_PATH" ] && [ ! -L "$SYMLINK_PATH" ]; then
  echo "Migrating old install..."
  # Preserve proxy token if it exists
  if [ -f "$SYMLINK_PATH/.proxy-token" ]; then
    cp "$SYMLINK_PATH/.proxy-token" "$DATA_DIR/.proxy-token"
    chmod 600 "$DATA_DIR/.proxy-token"
    echo "PASS: Proxy token migrated to $DATA_DIR/.proxy-token"
  fi
  rm -rf "$SYMLINK_PATH"
fi

# Create or update symlink
if [ -L "$SYMLINK_PATH" ]; then
  # Update existing symlink if it points elsewhere
  current_target="$(readlink "$SYMLINK_PATH")"
  if [ "$current_target" != "$REPO_DIR" ]; then
    rm "$SYMLINK_PATH"
    ln -s "$REPO_DIR" "$SYMLINK_PATH"
    echo "PASS: Symlink updated: $SYMLINK_PATH -> $REPO_DIR"
  else
    echo "PASS: Symlink already correct: $SYMLINK_PATH -> $REPO_DIR"
  fi
else
  ln -s "$REPO_DIR" "$SYMLINK_PATH"
  echo "PASS: Symlink created: $SYMLINK_PATH -> $REPO_DIR"
fi

echo ""

# --- 3. Generate proxy token ---
echo "--- Proxy token ---"

TOKEN_FILE="$DATA_DIR/.proxy-token"
if [ -f "$TOKEN_FILE" ]; then
  echo "PASS: Proxy token already exists"
else
  openssl rand -hex 32 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "PASS: Proxy token generated at $TOKEN_FILE"
fi

# Copy token into repo for Docker build context
cp "$TOKEN_FILE" "$REPO_DIR/.proxy-token"

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

if grep -q "alias moat=" "$SHELL_RC" 2>/dev/null; then
  echo "PASS: Shell aliases already in $SHELL_RC"
else
  cat >> "$SHELL_RC" << 'ALIASES'

# Moat — sandboxed Claude Code
alias moat='~/.devcontainers/moat/moat.sh'
alias moat-plan='~/.devcontainers/moat/moat.sh --allowedTools "Read,Grep,Glob,Task,WebFetch,WebSearch"'
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

docker compose --project-name moat \
  -f "$REPO_DIR/docker-compose.yml" \
  -f "$REPO_DIR/docker-compose.extra-dirs.yml" build

echo ""
echo "PASS: Docker image built"

echo ""
echo "=============================="
echo "Setup complete!"
echo "=============================="
echo ""
echo "Usage:"
echo "  moat                                     # Full access (default: cwd)"
echo "  moat ~/Projects/myapp                   # Target a specific repo"
echo "  moat . --add-dir ~/Projects/shared-lib  # Mount extra directories"
echo "  moat-plan                               # Read-only tools only"
echo ""
echo "Update:"
echo "  moat update                             # Pull latest + rebuild"
echo ""
echo "You may need to restart your shell for aliases to take effect:"
echo "  source $SHELL_RC"
echo ""
