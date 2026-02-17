#!/bin/bash
# Moat — uninstaller
# Removes all Moat artifacts from the system.
# Usage: moat uninstall [--force]
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

done_msg()  { echo -e "  ${GREEN}✓${RESET} $1"; }
skip_msg()  { echo -e "  ${DIM}· $1${RESET}"; }
warn_msg()  { echo -e "  ${YELLOW}! $1${RESET}"; }
section()   { echo -e "\n${BOLD}${CYAN}[$1]${RESET}"; }

# --- Self-locate: resolve symlinks to find the repo directory ---
resolve_path() {
  local path="$1"
  while [ -L "$path" ]; do
    local dir
    dir="$(cd -P "$(dirname "$path")" && pwd)"
    path="$(readlink "$path")"
    [[ "$path" != /* ]] && path="$dir/$path"
  done
  echo "$(cd -P "$(dirname "$path")" && pwd)/$(basename "$path")"
}

SCRIPT_PATH="$(resolve_path "${BASH_SOURCE[0]}")"
REPO_DIR="$(dirname "$SCRIPT_PATH")"

FORCE=false
if [ "${1:-}" = "--force" ]; then
  FORCE=true
fi

# Prompt helper — returns 0 (yes) or 1 (no). --force always returns 0.
confirm() {
  if $FORCE; then return 0; fi
  printf "  ${CYAN}?${RESET} %s ${DIM}[y/N]${RESET} " "$1"
  read -r answer
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

echo ""
echo -e "${BOLD}Moat Uninstaller${RESET}"

# --- 1. Stop running containers & tool proxy ---
section "Containers & tool proxy"

# Terminate any active mutagen sync sessions
if command -v mutagen &>/dev/null; then
  if mutagen sync list --label-selector moat=true 2>/dev/null | grep -q "Name:"; then
    mutagen sync terminate --label-selector moat=true 2>/dev/null || true
    done_msg "Mutagen sync sessions terminated"
  else
    skip_msg "No active mutagen sync sessions"
  fi
fi

# Build compose file args (extra-dirs may not exist)
COMPOSE_FILES=(-f "$REPO_DIR/docker-compose.yml")
if [ -f "$REPO_DIR/docker-compose.extra-dirs.yml" ]; then
  COMPOSE_FILES+=(-f "$REPO_DIR/docker-compose.extra-dirs.yml")
fi

if [ -f "$REPO_DIR/docker-compose.yml" ] && \
   docker compose --project-name moat "${COMPOSE_FILES[@]}" \
    ps --status running 2>/dev/null | grep -q .; then
  warn_msg "Running containers detected"
  if confirm "Stop containers?"; then
    docker compose --project-name moat "${COMPOSE_FILES[@]}" down 2>/dev/null || true
    done_msg "Containers stopped"
  else
    skip_msg "Containers left running"
  fi
else
  skip_msg "No running containers"
fi

# Kill tool proxy
if [ -f /tmp/moat-tool-proxy.pid ]; then
  kill "$(cat /tmp/moat-tool-proxy.pid)" 2>/dev/null || true
  rm -f /tmp/moat-tool-proxy.pid
  done_msg "Tool proxy stopped"
fi
lsof -ti :9876 2>/dev/null | xargs kill 2>/dev/null || true

# --- 2. Remove Docker volumes ---
section "Docker volumes"

existing_volumes=()
for vol in moat_moat-bashhistory moat_moat-config; do
  if docker volume inspect "$vol" &>/dev/null 2>&1; then
    existing_volumes+=("$vol")
  fi
done

if [ ${#existing_volumes[@]} -gt 0 ]; then
  warn_msg "Found: ${existing_volumes[*]}"
  echo -e "  ${RED}This destroys session history and Claude config.${RESET}"
  if confirm "Remove Docker volumes?"; then
    for vol in "${existing_volumes[@]}"; do
      docker volume rm "$vol" 2>/dev/null || true
    done
    done_msg "Volumes removed"
  else
    skip_msg "Volumes kept"
  fi
else
  skip_msg "No Moat volumes found"
fi

# --- 3. Remove Docker images ---
section "Docker images"

existing_images=()
for img in moat-devcontainer ubuntu/squid; do
  if docker images --format '{{.Repository}}' 2>/dev/null | grep -q "^${img}$"; then
    existing_images+=("$img")
  fi
done

if [ ${#existing_images[@]} -gt 0 ]; then
  warn_msg "Found: ${existing_images[*]}"
  if confirm "Remove Docker images?"; then
    for img in "${existing_images[@]}"; do
      docker rmi "$img" 2>/dev/null || true
    done
    done_msg "Images removed"
  else
    skip_msg "Images kept"
  fi
else
  skip_msg "No Moat images found"
fi

# --- 4. Remove Docker networks ---
section "Docker networks"

existing_networks=()
for net in moat_sandbox moat_extnet; do
  if docker network inspect "$net" &>/dev/null 2>&1; then
    existing_networks+=("$net")
  fi
done

if [ ${#existing_networks[@]} -gt 0 ]; then
  warn_msg "Found: ${existing_networks[*]}"
  if confirm "Remove Docker networks?"; then
    for net in "${existing_networks[@]}"; do
      docker network rm "$net" 2>/dev/null || true
    done
    done_msg "Networks removed"
  else
    skip_msg "Networks kept"
  fi
else
  skip_msg "No Moat networks found"
fi

# --- 5. Remove host data ---
section "Host data"

if [ -d "$HOME/.moat" ]; then
  warn_msg "Found ~/.moat/"
  if confirm "Remove ~/.moat/ (proxy token, data)?"; then
    rm -rf "$HOME/.moat"
    done_msg "~/.moat/ removed"
  else
    skip_msg "~/.moat/ kept"
  fi
else
  skip_msg "~/.moat/ not found"
fi

# --- 6. Remove symlinks ---
section "Symlinks"

if [ -L "$HOME/.devcontainers/moat" ]; then
  rm -f "$HOME/.devcontainers/moat"
  done_msg "Removed ~/.devcontainers/moat"
elif [ -d "$HOME/.devcontainers/moat" ]; then
  if confirm "Remove ~/.devcontainers/moat/ (legacy directory)?"; then
    rm -rf "$HOME/.devcontainers/moat"
    done_msg "Removed ~/.devcontainers/moat/"
  else
    skip_msg "~/.devcontainers/moat/ kept"
  fi
else
  skip_msg "~/.devcontainers/moat not found"
fi

if [ -L "$HOME/.local/bin/moat" ]; then
  rm -f "$HOME/.local/bin/moat"
  done_msg "Removed ~/.local/bin/moat"
else
  skip_msg "~/.local/bin/moat not found"
fi

if [ -L /usr/local/bin/moat ]; then
  rm -f /usr/local/bin/moat
  done_msg "Removed /usr/local/bin/moat"
else
  skip_msg "/usr/local/bin/moat not found"
fi

# Homebrew bin
if command -v brew &>/dev/null; then
  BREW_MOAT="$(brew --prefix)/bin/moat"
  if [ -L "$BREW_MOAT" ]; then
    rm -f "$BREW_MOAT"
    done_msg "Removed $BREW_MOAT"
  fi
fi

# --- 7. Clean shell RC files ---
section "Shell config"

clean_rc() {
  local rc="$1"
  if [ ! -f "$rc" ]; then return; fi
  local cleaned=false

  # Old-style aliases
  if grep -qE '(alias moat=|alias moat-plan=|# Moat —)' "$rc" 2>/dev/null; then
    sed -i.bak '/# Moat —/d; /alias moat=/d; /alias moat-plan=/d' "$rc"
    rm -f "${rc}.bak"
    cleaned=true
  fi

  # PATH entry added by install.sh
  if grep -q '# Moat — sandboxed Claude Code' "$rc" 2>/dev/null; then
    sed -i.bak '/# Moat — sandboxed Claude Code/d' "$rc"
    rm -f "${rc}.bak"
    if grep -qx 'export PATH="$HOME/.local/bin:$PATH"' "$rc" 2>/dev/null; then
      sed -i.bak '\|^export PATH="\$HOME/\.local/bin:\$PATH"$|d' "$rc"
      rm -f "${rc}.bak"
    fi
    cleaned=true
  fi

  if $cleaned; then
    done_msg "Cleaned $(basename "$rc")"
  fi
}

for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  clean_rc "$rc"
done

# --- 8. Remove temp files ---
section "Temp files"

removed_tmp=false
for f in /tmp/moat-tool-proxy.pid /tmp/moat-tool-proxy.log; do
  if [ -f "$f" ]; then
    rm -f "$f"
    removed_tmp=true
  fi
done

if $removed_tmp; then
  done_msg "Temp files removed"
else
  skip_msg "No temp files found"
fi

# --- 9. Clean repo-local generated files ---
section "Generated files"

removed_repo=false
for f in "$REPO_DIR/.proxy-token" "$REPO_DIR/docker-compose.extra-dirs.yml"; do
  if [ -f "$f" ]; then
    rm -f "$f"
    removed_repo=true
  fi
done

if $removed_repo; then
  done_msg "Generated files removed"
else
  skip_msg "No generated files found"
fi

# --- Done ---
echo ""
echo -e "${GREEN}${BOLD}Uninstall complete.${RESET}"
echo ""
echo -e "  The repo was ${BOLD}not${RESET} removed:"
echo -e "  ${DIM}$REPO_DIR${RESET}"
echo ""
echo -e "  To fully remove it:  ${BOLD}rm -rf $REPO_DIR${RESET}"
echo ""
