#!/bin/bash
# Moat — Lightweight installer (assumes prerequisites are installed)
# Usage: curl -fsSL https://raw.githubusercontent.com/srinivasgumdelli/moat/main/install.sh | bash
set -euo pipefail

REPO_URL="https://github.com/srinivasgumdelli/moat.git"
INSTALL_DIR="$HOME/.local/share/moat"
SYMLINK_PATH="$HOME/.devcontainers/moat"
DATA_DIR="$HOME/.local/share/moat-data"

echo "=============================="
echo "Moat Installer"
echo "=============================="
echo ""

# --- 1. Check prerequisites ---
echo "--- Checking prerequisites ---"

missing=()
if ! command -v git &>/dev/null; then missing+=(git); fi
if ! command -v docker &>/dev/null; then missing+=(docker); fi
if ! command -v node &>/dev/null; then missing+=(node); fi

if [ ${#missing[@]} -gt 0 ]; then
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
  echo ""
  echo "Or run the full setup instead:"
  echo "  git clone $REPO_URL && cd moat && ./setup.sh"
  exit 1
fi
echo "PASS: git, docker, node found"

# Check Docker daemon
if ! docker info &>/dev/null 2>&1; then
  echo "ERROR: Docker daemon not running. Launch Docker Desktop and try again."
  exit 1
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

echo ""

# --- 2. Clone or update repo ---
echo "--- Installing Moat ---"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing install..."
  git -C "$INSTALL_DIR" pull --ff-only
  echo "PASS: Repo updated"
else
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
  echo "PASS: Repo cloned to $INSTALL_DIR"
fi

echo ""

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
  if [ "$current_target" != "$INSTALL_DIR" ]; then
    rm "$SYMLINK_PATH"
    ln -s "$INSTALL_DIR" "$SYMLINK_PATH"
    echo "PASS: Symlink updated: $SYMLINK_PATH -> $INSTALL_DIR"
  else
    echo "PASS: Symlink already correct"
  fi
else
  ln -s "$INSTALL_DIR" "$SYMLINK_PATH"
  echo "PASS: Symlink created: $SYMLINK_PATH -> $INSTALL_DIR"
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
cp "$TOKEN_FILE" "$INSTALL_DIR/.proxy-token"

echo ""

# --- 5. Install moat on PATH ---
echo "--- Shell configuration ---"

# Create symlink in ~/.local/bin
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/moat.sh" "$HOME/.local/bin/moat"
echo "PASS: Symlink created: ~/.local/bin/moat -> $INSTALL_DIR/moat.sh"

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

# --- 6. Build Docker image ---
echo "--- Building Docker image ---"
echo "This may take 5-10 minutes on first run (cached after that)..."
echo ""

docker compose --project-name moat \
  -f "$INSTALL_DIR/docker-compose.yml" \
  -f "$INSTALL_DIR/docker-compose.extra-dirs.yml" build

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
