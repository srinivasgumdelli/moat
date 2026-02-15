#!/bin/bash
# Moat — Unified installer
# Works two ways:
#   1. curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash   (standalone)
#   2. git clone ... && cd moat && ./install.sh                             (in-repo)
set -euo pipefail

# --- Colors (disabled when not a terminal) ---
if [ -t 1 ]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
else
  BOLD='' DIM='' RED='' GREEN='' YELLOW='' CYAN='' RESET=''
fi

pass_msg()    { echo -e "  ${GREEN}✓${RESET} $1"; }
warn_msg()    { echo -e "  ${YELLOW}!${RESET} $1"; }
fail_msg()    { echo -e "  ${RED}✗${RESET} $1"; }
action_msg()  { echo -e "  ${CYAN}→${RESET} $1"; }
section()     { echo -e "\n${BOLD}${CYAN}[$1]${RESET}"; }

REPO_URL="https://github.com/srinivasgumdelli/moat.git"
INSTALL_DIR="$HOME/.moat"
SYMLINK_PATH="$HOME/.devcontainers/moat"
DATA_DIR="$HOME/.moat/data"

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

echo ""
echo -e "${BOLD}Moat Installer${RESET}"

HAS_BREW=false
if command -v brew &>/dev/null; then
  HAS_BREW=true
fi

# --- Helper: install via Homebrew if available ---
brew_install() {
  local cmd=$1 pkg=$2
  if command -v "$cmd" &>/dev/null; then
    pass_msg "$cmd already installed"
    return 0
  fi
  if $HAS_BREW; then
    action_msg "Installing $cmd via brew..."
    brew install "$pkg"
    pass_msg "$cmd installed"
    return 0
  fi
  return 1
}

# --- 1. Prerequisites ---
section "Prerequisites"

missing=()

# Git
if ! command -v git &>/dev/null; then
  if $HAS_BREW; then
    action_msg "Installing git via brew..."
    brew install git
    pass_msg "git installed"
  else
    missing+=(git)
  fi
else
  pass_msg "git already installed"
fi

# Docker
if ! command -v docker &>/dev/null; then
  if $HAS_BREW; then
    action_msg "Installing Docker Desktop via brew..."
    brew install --cask docker
    pass_msg "Docker Desktop installed"
    echo ""
    echo -e "  ${CYAN}?${RESET} Please launch Docker Desktop and press Enter when running..."
    read -r
  else
    missing+=(docker)
  fi
fi

# Node.js
if ! command -v node &>/dev/null; then
  if $HAS_BREW; then
    action_msg "Installing node via brew..."
    brew install node
    pass_msg "node installed"
  else
    missing+=(node)
  fi
else
  pass_msg "node already installed"
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo ""
  fail_msg "Missing required tools: ${missing[*]}"
  echo ""
  echo "  Install them first:"
  for cmd in "${missing[@]}"; do
    case "$cmd" in
      git)    echo -e "    ${DIM}brew install git${RESET}" ;;
      docker) echo -e "    ${DIM}brew install --cask docker  (then launch Docker Desktop)${RESET}" ;;
      node)   echo -e "    ${DIM}brew install node${RESET}" ;;
    esac
  done
  exit 1
fi

# Docker daemon
if ! docker info &>/dev/null 2>&1; then
  action_msg "Waiting for Docker daemon..."
  for i in $(seq 1 30); do
    if docker info &>/dev/null 2>&1; then
      break
    fi
    if [ "$i" -eq 30 ]; then
      fail_msg "Docker daemon not responding after 30s. Launch Docker Desktop and re-run."
      exit 1
    fi
    sleep 1
  done
fi
pass_msg "Docker daemon running"

# devcontainer CLI
if ! command -v devcontainer &>/dev/null; then
  action_msg "Installing devcontainer CLI..."
  npm install -g @devcontainers/cli
  pass_msg "devcontainer CLI installed"
else
  pass_msg "devcontainer CLI already installed"
fi

# Optional tools (only when brew is available)
if $HAS_BREW; then
  brew_install gh gh
  if command -v gh &>/dev/null && ! gh auth status &>/dev/null 2>&1; then
    warn_msg "gh not authenticated. Run: gh auth login"
  fi
  brew_install terraform hashicorp/tap/terraform
  brew_install kubectl kubectl
  brew_install aws awscli
  brew_install mutagen mutagen-io/mutagen/mutagen
fi

# --- 2. Clone or update repo (standalone mode only) ---
if [ "$MODE" = "standalone" ]; then
  section "Repository"

  if [ -d "$REPO_DIR/.git" ]; then
    action_msg "Updating existing install..."
    git -C "$REPO_DIR" pull --ff-only
    pass_msg "Repo updated"
  else
    if [ -d "$REPO_DIR" ]; then
      rm -rf "$REPO_DIR"
    fi
    mkdir -p "$(dirname "$REPO_DIR")"
    git clone "$REPO_URL" "$REPO_DIR"
    pass_msg "Repo cloned to $REPO_DIR"
  fi
fi

# --- 3. Create symlink ---
section "Configuration"

mkdir -p "$(dirname "$SYMLINK_PATH")"
mkdir -p "$DATA_DIR"

# Migrate old directory-based installs
if [ -d "$SYMLINK_PATH" ] && [ ! -L "$SYMLINK_PATH" ]; then
  action_msg "Migrating old install..."
  if [ -f "$SYMLINK_PATH/.proxy-token" ]; then
    cp "$SYMLINK_PATH/.proxy-token" "$DATA_DIR/.proxy-token"
    chmod 600 "$DATA_DIR/.proxy-token"
    pass_msg "Proxy token migrated to $DATA_DIR/.proxy-token"
  fi
  rm -rf "$SYMLINK_PATH"
fi

# Create or update symlink
if [ -L "$SYMLINK_PATH" ]; then
  current_target="$(readlink "$SYMLINK_PATH")"
  if [ "$current_target" != "$REPO_DIR" ]; then
    rm "$SYMLINK_PATH"
    ln -s "$REPO_DIR" "$SYMLINK_PATH"
    pass_msg "Symlink updated: ~/.devcontainers/moat -> $REPO_DIR"
  else
    pass_msg "Symlink already correct"
  fi
else
  ln -s "$REPO_DIR" "$SYMLINK_PATH"
  pass_msg "Symlink created: ~/.devcontainers/moat -> $REPO_DIR"
fi

# --- 4. Generate proxy token ---
section "Proxy token"

TOKEN_FILE="$DATA_DIR/.proxy-token"
if [ -f "$TOKEN_FILE" ]; then
  pass_msg "Proxy token already exists"
else
  openssl rand -hex 32 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  pass_msg "Proxy token generated"
fi

# Copy token into repo for Docker build context
cp "$TOKEN_FILE" "$REPO_DIR/.proxy-token"

# --- 5. Install moat on PATH ---
section "Shell"

# Create symlink in ~/.local/bin
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/moat.sh" "$HOME/.local/bin/moat"
pass_msg "Symlink: ~/.local/bin/moat -> moat.sh"

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
  pass_msg "Removed old aliases from $(basename "$SHELL_RC")"
fi

# Ensure ~/.local/bin is on PATH
if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$SHELL_RC" 2>/dev/null; then
  if echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
    pass_msg "~/.local/bin already on PATH"
  else
    printf '\n# Moat — sandboxed Claude Code\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$SHELL_RC"
    pass_msg "Added ~/.local/bin to PATH in $(basename "$SHELL_RC")"
  fi
else
  pass_msg "~/.local/bin already in $(basename "$SHELL_RC")"
fi

# --- 6. Check ANTHROPIC_API_KEY ---
section "API key"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  pass_msg "ANTHROPIC_API_KEY is set"
else
  warn_msg "ANTHROPIC_API_KEY not set in environment"
  echo -e "    ${DIM}Add to your shell profile: export ANTHROPIC_API_KEY=sk-ant-...${RESET}"
fi

# --- 7. Build Docker image ---
section "Docker image"
echo -e "  ${DIM}This may take a few minutes on first run (cached after that)...${RESET}"
echo ""

# Ensure override files exist (moat.sh generates them at runtime, but we need them for build)
if [ ! -f "$REPO_DIR/docker-compose.extra-dirs.yml" ]; then
  printf 'services:\n  devcontainer: {}\n' > "$REPO_DIR/docker-compose.extra-dirs.yml"
fi
if [ ! -f "$REPO_DIR/docker-compose.services.yml" ]; then
  printf 'services:\n  devcontainer: {}\n' > "$REPO_DIR/docker-compose.services.yml"
fi

docker compose --project-name moat \
  -f "$REPO_DIR/docker-compose.yml" \
  -f "$REPO_DIR/docker-compose.services.yml" \
  -f "$REPO_DIR/docker-compose.extra-dirs.yml" build

echo ""
pass_msg "Docker image built"

# --- Done ---
echo ""
echo -e "${GREEN}${BOLD}Install complete.${RESET}"
echo ""
echo "  Usage:"
echo -e "    ${BOLD}moat${RESET}                                     # Full access (default: cwd)"
echo -e "    ${BOLD}moat${RESET} ~/Projects/myapp                   # Target a specific repo"
echo -e "    ${BOLD}moat${RESET} . --add-dir ~/Projects/shared-lib  # Mount extra directories"
echo -e "    ${BOLD}moat plan${RESET}                               # Read-only tools only"
echo -e "    ${BOLD}moat attach${RESET} ~/Projects/shared-lib       # Live-sync dir into running session"
echo -e "    ${BOLD}moat detach${RESET} shared-lib                  # Stop syncing"
echo ""
echo "  Update:"
echo -e "    ${BOLD}moat update${RESET}                             # Pull latest + rebuild"
echo ""
echo -e "  Restart your shell or run: ${BOLD}source $SHELL_RC${RESET}"
echo ""
