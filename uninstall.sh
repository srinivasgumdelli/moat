#!/bin/bash
# Moat — uninstaller
# Removes all Moat artifacts from the system.
# Usage: moat uninstall [--force]
set -euo pipefail

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
  printf "%s [y/N] " "$1"
  read -r answer
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

echo "=============================="
echo "Moat Uninstaller"
echo "=============================="
echo ""

# --- 1. Stop running containers & tool proxy ---
echo "--- Stop containers & tool proxy ---"

# Build compose file args (extra-dirs may not exist)
COMPOSE_FILES=(-f "$REPO_DIR/docker-compose.yml")
if [ -f "$REPO_DIR/docker-compose.extra-dirs.yml" ]; then
  COMPOSE_FILES+=(-f "$REPO_DIR/docker-compose.extra-dirs.yml")
fi

if [ -f "$REPO_DIR/docker-compose.yml" ] && \
   docker compose --project-name moat "${COMPOSE_FILES[@]}" \
    ps --status running --format '{{.Name}}' 2>/dev/null | grep -q .; then
  echo "Running Moat containers detected."
  if confirm "Stop containers?"; then
    docker compose --project-name moat "${COMPOSE_FILES[@]}" down 2>/dev/null || true
    echo "DONE: Containers stopped"
  else
    echo "SKIP: Containers left running"
  fi
else
  echo "SKIP: No running containers"
fi

# Kill tool proxy
if [ -f /tmp/moat-tool-proxy.pid ]; then
  kill "$(cat /tmp/moat-tool-proxy.pid)" 2>/dev/null || true
  rm -f /tmp/moat-tool-proxy.pid
  echo "DONE: Tool proxy stopped (pidfile)"
fi
lsof -ti :9876 2>/dev/null | xargs kill 2>/dev/null || true

echo ""

# --- 2. Remove Docker volumes ---
echo "--- Docker volumes ---"

existing_volumes=()
for vol in moat_moat-bashhistory moat_moat-config; do
  if docker volume inspect "$vol" &>/dev/null 2>&1; then
    existing_volumes+=("$vol")
  fi
done

if [ ${#existing_volumes[@]} -gt 0 ]; then
  echo "Found volumes: ${existing_volumes[*]}"
  echo "WARNING: This destroys session history and Claude config."
  if confirm "Remove Docker volumes?"; then
    for vol in "${existing_volumes[@]}"; do
      docker volume rm "$vol" 2>/dev/null || true
    done
    echo "DONE: Volumes removed"
  else
    echo "SKIP: Volumes kept"
  fi
else
  echo "SKIP: No Moat volumes found"
fi

echo ""

# --- 3. Remove Docker images ---
echo "--- Docker images ---"

existing_images=()
for img in moat-devcontainer ubuntu/squid; do
  if docker images --format '{{.Repository}}' 2>/dev/null | grep -q "^${img}$"; then
    existing_images+=("$img")
  fi
done

if [ ${#existing_images[@]} -gt 0 ]; then
  echo "Found images: ${existing_images[*]}"
  if confirm "Remove Docker images?"; then
    for img in "${existing_images[@]}"; do
      docker rmi "$img" 2>/dev/null || true
    done
    echo "DONE: Images removed"
  else
    echo "SKIP: Images kept"
  fi
else
  echo "SKIP: No Moat images found"
fi

echo ""

# --- 4. Remove Docker networks ---
echo "--- Docker networks ---"

existing_networks=()
for net in moat_sandbox moat_extnet; do
  if docker network inspect "$net" &>/dev/null 2>&1; then
    existing_networks+=("$net")
  fi
done

if [ ${#existing_networks[@]} -gt 0 ]; then
  echo "Found networks: ${existing_networks[*]}"
  if confirm "Remove Docker networks?"; then
    for net in "${existing_networks[@]}"; do
      docker network rm "$net" 2>/dev/null || true
    done
    echo "DONE: Networks removed"
  else
    echo "SKIP: Networks kept"
  fi
else
  echo "SKIP: No Moat networks found"
fi

echo ""

# --- 5. Remove host data ---
echo "--- Host data (~/.moat/) ---"

if [ -d "$HOME/.moat" ]; then
  echo "Found ~/.moat/"
  if confirm "Remove ~/.moat/ (proxy token, data)?"; then
    rm -rf "$HOME/.moat"
    echo "DONE: ~/.moat/ removed"
  else
    echo "SKIP: ~/.moat/ kept"
  fi
else
  echo "SKIP: ~/.moat/ not found"
fi

echo ""

# --- 6. Remove symlinks ---
echo "--- Symlinks ---"

if [ -L "$HOME/.devcontainers/moat" ]; then
  rm -f "$HOME/.devcontainers/moat"
  echo "DONE: Removed ~/.devcontainers/moat"
elif [ -d "$HOME/.devcontainers/moat" ]; then
  if confirm "Remove ~/.devcontainers/moat/ (legacy directory install)?"; then
    rm -rf "$HOME/.devcontainers/moat"
    echo "DONE: Removed ~/.devcontainers/moat/"
  else
    echo "SKIP: ~/.devcontainers/moat/ kept"
  fi
else
  echo "SKIP: ~/.devcontainers/moat not found"
fi

if [ -L "$HOME/.local/bin/moat" ]; then
  rm -f "$HOME/.local/bin/moat"
  echo "DONE: Removed ~/.local/bin/moat"
else
  echo "SKIP: ~/.local/bin/moat not found"
fi

echo ""

# --- 7. Clean shell RC files ---
echo "--- Shell RC files ---"

clean_rc() {
  local rc="$1"
  if [ ! -f "$rc" ]; then return; fi

  # Check for any Moat-related lines
  if grep -qE '(alias moat=|alias moat-plan=|# Moat —)' "$rc" 2>/dev/null; then
    sed -i.bak '/# Moat —/d; /alias moat=/d; /alias moat-plan=/d' "$rc"
    rm -f "${rc}.bak"
    echo "DONE: Cleaned old aliases from $rc"
  fi

  # Check for PATH entry added by install.sh
  if grep -q '# Moat — sandboxed Claude Code' "$rc" 2>/dev/null; then
    sed -i.bak '/# Moat — sandboxed Claude Code/d' "$rc"
    rm -f "${rc}.bak"
    # Remove the PATH line only if it was the one we added (next line after our comment)
    # The comment is already gone, so check for orphaned PATH line
    if grep -qx 'export PATH="$HOME/.local/bin:$PATH"' "$rc" 2>/dev/null; then
      sed -i.bak '\|^export PATH="\$HOME/\.local/bin:\$PATH"$|d' "$rc"
      rm -f "${rc}.bak"
    fi
    echo "DONE: Cleaned PATH entry from $rc"
  fi
}

for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  clean_rc "$rc"
done

echo ""

# --- 8. Remove temp files ---
echo "--- Temp files ---"

removed_tmp=false
for f in /tmp/moat-tool-proxy.pid /tmp/moat-tool-proxy.log; do
  if [ -f "$f" ]; then
    rm -f "$f"
    removed_tmp=true
  fi
done

if $removed_tmp; then
  echo "DONE: Temp files removed"
else
  echo "SKIP: No temp files found"
fi

echo ""

# --- 9. Clean repo-local generated files ---
echo "--- Repo-local generated files ---"

removed_repo=false
for f in "$REPO_DIR/.proxy-token" "$REPO_DIR/docker-compose.extra-dirs.yml"; do
  if [ -f "$f" ]; then
    rm -f "$f"
    removed_repo=true
  fi
done

if $removed_repo; then
  echo "DONE: Generated files removed from $REPO_DIR"
else
  echo "SKIP: No generated files found"
fi

echo ""

# --- Done ---
echo "=============================="
echo "Moat uninstall complete."
echo "=============================="
echo ""
echo "The repo directory itself was NOT removed:"
echo "  $REPO_DIR"
echo ""
echo "To fully remove it:  rm -rf $REPO_DIR"
