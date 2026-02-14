#!/bin/bash
# Moat — Unified installer
# Works two ways:
#   1. curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash   (standalone)
#   2. git clone ... && cd moat && ./install.sh                             (in-repo)
set -euo pipefail

REPO_URL="https://github.com/srinivasgumdelli/moat.git"
INSTALL_DIR="$HOME/.local/share/moat"
SYMLINK_PATH="$HOME/.devcontainers/moat"
DATA_DIR="$HOME/.local/share/moat-data"

# --- Detect context ---
# If moat.sh exists next to this script, we're running from a cloned repo.
# When piped via curl, $0 is "bash" / "/bin/bash" so dirname won't contain moat.sh.
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || SCRIPT_DIR=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/moat.sh" ]; then
  MODE="in-repo"
  REPO_DIR="$SCRIPT_DIR"
else
  MODE="standalone"
  REPO_DIR="$INSTALL_DIR"
fi

echo "=============================="
echo "Moat Installer"
echo "=============================="
echo ""

HAS_BREW=false
if command -v brew &>/dev/null; then
  HAS_BREW=true
fi

# --- Helper: install via Homebrew if available ---
brew_install() {
  local cmd=$1 pkg=$2
  if command -v "$cmd" &>/dev/null; then
    echo "PASS: $cmd already installed"
    return 0
  fi
  if $HAS_BREW; then
    echo "INSTALLING: $cmd via brew..."
    brew install "$pkg"
    echo "PASS: $cmd installed"
    return 0
  fi
  return 1
}

# --- 1. Prerequisites ---
echo "--- Checking prerequisites ---"

missing=()

# Git
if ! command -v git &>/dev/null; then
  if $HAS_BREW; then
    echo "INSTALLING: git via brew..."
    brew install git
    echo "PASS: git installed"
  else
    missing+=(git)
  fi
else
  echo "PASS: git already installed"
fi

# Docker
if ! command -v docker &>/dev/null; then
  if $HAS_BREW; then
    echo "INSTALLING: Docker Desktop via brew..."
    brew install --cask docker
    echo "PASS: Docker Desktop installed"
    echo ""
    echo ">>> Please launch Docker Desktop from Applications and wait for it to start."
    echo ">>> Press Enter when Docker is running..."
    read -r
  else
    missing+=(docker)
  fi
fi

# Node.js
if ! command -v node &>/dev/null; then
  if $HAS_BREW; then
    echo "INSTALLING: node via brew..."
    brew install node
    echo "PASS: node installed"
  else
    missing+=(node)
  fi
else
  echo "PASS: node already installed"
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo ""
  echo "ERROR: Missing required tools: ${missing[*]}"
  echo ""
  echo "Install them first:"
  for cmd in "${missing[@]}"; do
    case "$cmd" in
      git)    echo "  brew install git" ;;
      docker) echo "  brew install --cask docker  (then launch Docker Desktop)" ;;
      node)   echo "  brew install node" ;;
    esac
  done
  exit 1
fi

# Docker daemon
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
echo "PASS: Docker daemon running"

# devcontainer CLI
if ! command -v devcontainer &>/dev/null; then
  echo "INSTALLING: devcontainer CLI..."
  npm install -g @devcontainers/cli
  echo "PASS: devcontainer CLI installed"
else
  echo "PASS: devcontainer CLI already installed"
fi

# Optional tools (only when brew is available)
if $HAS_BREW; then
  brew_install gh gh
  if command -v gh &>/dev/null && ! gh auth status &>/dev/null 2>&1; then
    echo "WARN: gh not authenticated. Run: gh auth login"
  fi
  brew_install terraform hashicorp/tap/terraform
  brew_install kubectl kubectl
  brew_install aws awscli
fi

echo ""

# --- 2. Clone or update repo (standalone mode only) ---
if [ "$MODE" = "standalone" ]; then
  echo "--- Installing Moat ---"

  if [ -d "$REPO_DIR/.git" ]; then
    echo "Updating existing install..."
    git -C "$REPO_DIR" pull --ff-only
    echo "PASS: Repo updated"
  else
    if [ -d "$REPO_DIR" ]; then
      rm -rf "$REPO_DIR"
    fi
    mkdir -p "$(dirname "$REPO_DIR")"
    git clone "$REPO_URL" "$REPO_DIR"
    echo "PASS: Repo cloned to $REPO_DIR"
  fi

  echo ""
fi

# --- 3. Create symlink ---
echo "--- Linking configuration ---"

mkdir -p "$(dirname "$SYMLINK_PATH")"
mkdir -p "$DATA_DIR"

# Migrate old directory-based installs
if [ -d "$SYMLINK_PATH" ] && [ ! -L "$SYMLINK_PATH" ]; then
  echo "Migrating old install..."
  if [ -f "$SYMLINK_PATH/.proxy-token" ]; then
    cp "$SYMLINK_PATH/.proxy-token" "$DATA_DIR/.proxy-token"
    chmod 600 "$DATA_DIR/.proxy-token"
    echo "PASS: Proxy token migrated to $DATA_DIR/.proxy-token"
  fi
  rm -rf "$SYMLINK_PATH"
fi

# Create or update symlink
if [ -L "$SYMLINK_PATH" ]; then
  current_target="$(readlink "$SYMLINK_PATH")"
  if [ "$current_target" != "$REPO_DIR" ]; then
    rm "$SYMLINK_PATH"
    ln -s "$REPO_DIR" "$SYMLINK_PATH"
    echo "PASS: Symlink updated: $SYMLINK_PATH -> $REPO_DIR"
  else
    echo "PASS: Symlink already correct"
  fi
else
  ln -s "$REPO_DIR" "$SYMLINK_PATH"
  echo "PASS: Symlink created: $SYMLINK_PATH -> $REPO_DIR"
fi

echo ""

# --- 4. Generate proxy token ---
echo "--- Proxy token ---"

TOKEN_FILE="$DATA_DIR/.proxy-token"
if [ -f "$TOKEN_FILE" ]; then
  echo "PASS: Proxy token already exists"
else
  openssl rand -hex 32 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "PASS: Proxy token generated"
fi

# Copy token into repo for Docker build context
cp "$TOKEN_FILE" "$REPO_DIR/.proxy-token"

echo ""

# --- 5. Install moat on PATH ---
echo "--- Shell configuration ---"

# Create symlink in ~/.local/bin
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/moat.sh" "$HOME/.local/bin/moat"
echo "PASS: Symlink created: ~/.local/bin/moat -> $REPO_DIR/moat.sh"

# Detect shell rc file
if [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
else
  SHELL_RC="$HOME/.profile"
fi

# Migrate old aliases
if grep -q "alias moat=" "$SHELL_RC" 2>/dev/null; then
  sed -i.bak '/# Moat — sandboxed Claude Code/d; /alias moat=/d; /alias moat-plan=/d' "$SHELL_RC"
  rm -f "${SHELL_RC}.bak"
  echo "PASS: Removed old aliases from $SHELL_RC"
fi

# Ensure ~/.local/bin is on PATH
if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$SHELL_RC" 2>/dev/null; then
  if echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
    echo "PASS: ~/.local/bin already on PATH"
  else
    printf '\n# Moat — sandboxed Claude Code\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$SHELL_RC"
    echo "PASS: Added ~/.local/bin to PATH in $SHELL_RC"
  fi
else
  echo "PASS: ~/.local/bin already in $SHELL_RC"
fi

echo ""

# --- 6. Check ANTHROPIC_API_KEY ---
echo "--- API key ---"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "PASS: ANTHROPIC_API_KEY is set"
else
  echo "WARN: ANTHROPIC_API_KEY not set in environment"
  echo "      Add to your shell profile: export ANTHROPIC_API_KEY=sk-ant-..."
fi

echo ""

# --- 7. Build Docker image ---
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
echo "Moat installed!"
echo "=============================="
echo ""
echo "Usage:"
echo "  moat                                     # Full access (default: cwd)"
echo "  moat ~/Projects/myapp                   # Target a specific repo"
echo "  moat . --add-dir ~/Projects/shared-lib  # Mount extra directories"
echo "  moat plan                               # Read-only tools only"
echo ""
echo "Update:"
echo "  moat update                             # Pull latest + rebuild"
echo ""
echo "Restart your shell or run:"
echo "  source $SHELL_RC"
echo ""
