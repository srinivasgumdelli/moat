#!/bin/bash
# Moat — sandboxed Claude Code launcher
# Usage: moat.sh [workspace_path] [--add-dir <path>...] [claude args...]
# Subcommands: doctor | update [--version X.Y.Z] | down | attach <dir> | detach <dir|--all> | plan | uninstall

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

log()  { echo -e "${CYAN}[moat]${RESET} $1"; }
err()  { echo -e "${RED}[moat]${RESET} $1"; }

# --- Self-locate: resolve symlinks to find the repo directory ---
resolve_path() {
  local path="$1"
  while [ -L "$path" ]; do
    local dir
    dir="$(cd -P "$(dirname "$path")" && pwd)"
    path="$(readlink "$path")"
    # If readlink returned a relative path, resolve it
    [[ "$path" != /* ]] && path="$dir/$path"
  done
  echo "$(cd -P "$(dirname "$path")" && pwd)/$(basename "$path")"
}

SCRIPT_PATH="$(resolve_path "${BASH_SOURCE[0]}")"
REPO_DIR="$(dirname "$SCRIPT_PATH")"
DATA_DIR="$HOME/.moat/data"
OVERRIDE_FILE="$REPO_DIR/docker-compose.extra-dirs.yml"
SERVICES_FILE="$REPO_DIR/docker-compose.services.yml"
PROXY_PIDFILE="/tmp/moat-tool-proxy.pid"
PROXY_LOG="/tmp/moat-tool-proxy.log"

# Handle uninstall early — before creating any directories
if [ "${1:-}" = "uninstall" ]; then
  shift
  exec bash "$REPO_DIR/uninstall.sh" "$@"
fi

# Ensure data directory exists
mkdir -p "$DATA_DIR"

# Auto-generate proxy token if missing (migration from old installs)
if [ ! -f "$DATA_DIR/.proxy-token" ]; then
  # Migrate from old location if it exists
  if [ -f "$HOME/.devcontainers/moat/.proxy-token" ] && [ ! -L "$HOME/.devcontainers/moat" ]; then
    cp "$HOME/.devcontainers/moat/.proxy-token" "$DATA_DIR/.proxy-token"
    log "Migrated proxy token to $DATA_DIR/.proxy-token"
  else
    openssl rand -hex 32 > "$DATA_DIR/.proxy-token"
    chmod 600 "$DATA_DIR/.proxy-token"
    log "Generated new proxy token at $DATA_DIR/.proxy-token"
  fi
fi

# Helper: copy token into repo dir for Docker build context
ensure_token_in_repo() {
  cp "$DATA_DIR/.proxy-token" "$REPO_DIR/.proxy-token"
}

# --- doctor subcommand ---
if [ "${1:-}" = "doctor" ]; then
  echo ""
  echo -e "${BOLD}Moat Doctor${RESET}"
  echo ""

  FAILS=0
  WARNS=0

  check_pass() { echo -e "  ${GREEN}✓${RESET} $1"; }
  check_warn() { echo -e "  ${YELLOW}!${RESET} $1"; WARNS=$((WARNS + 1)); }
  check_fail() { echo -e "  ${RED}✗${RESET} $1"; FAILS=$((FAILS + 1)); }
  check_info() { echo -e "  ${DIM}· $1${RESET}"; }

  # Symlink exists and points to repo
  if [ -L "$HOME/.devcontainers/moat" ]; then
    target="$(readlink "$HOME/.devcontainers/moat")"
    if [ "$target" = "$REPO_DIR" ]; then
      check_pass "Symlink ~/.devcontainers/moat -> $REPO_DIR"
    else
      check_warn "Symlink ~/.devcontainers/moat points to $target (expected $REPO_DIR)"
    fi
  elif [ -d "$HOME/.devcontainers/moat" ]; then
    check_warn "~/.devcontainers/moat is a directory (expected symlink to $REPO_DIR)"
  else
    check_fail "~/.devcontainers/moat not found (run install.sh)"
  fi

  # Token in data dir
  if [ -f "$DATA_DIR/.proxy-token" ]; then
    check_pass "Token exists at $DATA_DIR/.proxy-token"
  else
    check_fail "Token missing at $DATA_DIR/.proxy-token"
  fi

  # Token synced to repo
  if [ -f "$REPO_DIR/.proxy-token" ]; then
    check_pass "Token synced to repo dir"
  else
    check_warn "Token not synced to repo dir (will be copied on next build/launch)"
  fi

  # docker command
  if command -v docker &>/dev/null; then
    check_pass "docker command found"
  else
    check_fail "docker command not found"
  fi

  # node command
  if command -v node &>/dev/null; then
    check_pass "node command found"
  else
    check_fail "node command not found"
  fi

  # devcontainer CLI
  if command -v devcontainer &>/dev/null; then
    check_pass "devcontainer CLI found"
  else
    check_fail "devcontainer CLI not found"
  fi

  # Docker daemon responding
  if docker info &>/dev/null 2>&1; then
    check_pass "Docker daemon responding"
  else
    check_fail "Docker daemon not responding"
  fi

  # Docker image built
  if docker images --format '{{.Repository}}' 2>/dev/null | grep -q "moat"; then
    check_pass "Docker image built"
  else
    check_warn "Docker image not found (run 'moat update' to build)"
  fi

  # Tool proxy on :9876 (informational — only during sessions)
  if curl -sf http://127.0.0.1:9876/health &>/dev/null; then
    check_info "Tool proxy responding on :9876"
  else
    check_info "Tool proxy not running on :9876 (normal outside sessions)"
  fi

  # ANTHROPIC_API_KEY
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    check_pass "ANTHROPIC_API_KEY is set"
  else
    check_fail "ANTHROPIC_API_KEY not set"
  fi

  # Mutagen (optional, for attach/detach)
  if command -v mutagen &>/dev/null; then
    check_pass "mutagen installed (enables 'moat attach')"
    SYNC_COUNT=$(mutagen sync list --label-selector moat=true 2>/dev/null | grep -c "Name:" || true)
    if [ "$SYNC_COUNT" -gt 0 ]; then
      check_info "$SYNC_COUNT active moat sync session(s)"
    fi
  else
    check_info "mutagen not installed (optional, for 'moat attach' live-sync)"
  fi

  echo ""
  if [ "$FAILS" -gt 0 ]; then
    echo -e "  ${RED}${BOLD}$FAILS fail(s)${RESET}, $WARNS warn(s)"
    exit 1
  elif [ "$WARNS" -gt 0 ]; then
    echo -e "  ${GREEN}${BOLD}All checks passed${RESET}, $WARNS warn(s)"
    exit 0
  else
    echo -e "  ${GREEN}${BOLD}All checks passed${RESET}"
    exit 0
  fi
fi

# Handle subcommands
if [ "${1:-}" = "down" ]; then
  log "Tearing down containers..."
  if command -v mutagen &>/dev/null; then
    mutagen sync terminate --label-selector moat=true 2>/dev/null || true
  fi
  docker compose --project-name moat \
    -f "$REPO_DIR/docker-compose.yml" \
    -f "$SERVICES_FILE" \
    -f "$OVERRIDE_FILE" down 2>/dev/null || true
  # Also stop tool proxy
  if [ -f "$PROXY_PIDFILE" ]; then
    kill "$(cat "$PROXY_PIDFILE")" 2>/dev/null || true
    rm -f "$PROXY_PIDFILE"
  fi
  lsof -ti :9876 2>/dev/null | xargs kill 2>/dev/null || true
  log "Done."
  exit 0
fi

if [ "${1:-}" = "attach" ]; then
  shift
  if [ -z "${1:-}" ] || [ ! -d "${1:-}" ]; then
    err "Usage: moat attach <directory>"
    exit 1
  fi
  ATTACH_DIR="$(cd "$1" && pwd)"
  ATTACH_NAME="$(basename "$ATTACH_DIR")"

  # Check container is running
  if ! docker inspect moat-devcontainer-1 --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
    err "No running moat container. Start a session first with 'moat'."
    exit 1
  fi

  if command -v mutagen &>/dev/null; then
    # --- Live-sync via Mutagen (no restart needed) ---

    # Check for existing session with this basename
    if mutagen sync list --label-selector "moat=true,moat-dir=$ATTACH_NAME" 2>/dev/null | grep -q "Name:"; then
      err "A sync session for '$ATTACH_NAME' already exists. Detach it first with:"
      err "  moat detach $ATTACH_NAME"
      exit 1
    fi

    # Create target directory inside container
    docker exec moat-devcontainer-1 mkdir -p "/extra/$ATTACH_NAME"
    docker exec moat-devcontainer-1 chown node:node "/extra/$ATTACH_NAME"

    # Create mutagen sync session
    mutagen sync create \
      --name "moat-$ATTACH_NAME" \
      --label "moat=true" \
      --label "moat-dir=$ATTACH_NAME" \
      --sync-mode two-way-resolved \
      --default-owner-beta node \
      --default-group-beta node \
      --ignore-vcs \
      "$ATTACH_DIR" \
      "docker://moat-devcontainer-1/extra/$ATTACH_NAME"

    log "Attached ${BOLD}$ATTACH_DIR${RESET} -> ${BOLD}/extra/$ATTACH_NAME${RESET} (live-sync)"
    log "Tell Claude about it: ${DIM}\"I have an additional directory at /extra/$ATTACH_NAME\"${RESET}"
  else
    # --- Fallback: restart container with new bind mount ---

    log "${YELLOW}mutagen not installed — falling back to container restart.${RESET}"
    log "This will ${BOLD}end the current Claude session${RESET}."
    log "For live-sync without restarting: ${DIM}brew install mutagen-io/mutagen/mutagen${RESET}"
    echo ""
    printf "  ${CYAN}?${RESET} Restart container to add ${BOLD}/extra/$ATTACH_NAME${RESET}? ${DIM}[y/N]${RESET} "
    read -r answer
    case "$answer" in
      [yY]|[yY][eE][sS]) ;;
      *)
        log "Aborted."
        exit 0
        ;;
    esac

    # Read current workspace from the running container
    ATTACH_WORKSPACE=$(docker inspect moat-devcontainer-1 \
      --format '{{index .Config.Labels "devcontainer.local_folder"}}' 2>/dev/null)

    # Collect existing /extra/* bind mount sources + add the new one
    EXISTING_EXTRA_SOURCES=$(docker inspect moat-devcontainer-1 \
      --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}} {{.Source}}{{"\n"}}{{end}}{{end}}' 2>/dev/null \
      | grep '^/extra/' | awk '{print $2}') || true

    {
      echo "services:"
      echo "  devcontainer:"
      echo "    volumes:"
      # Re-add existing extra mounts
      while IFS= read -r src; do
        [ -z "$src" ] && continue
        echo "      - ${src}:/extra/$(basename "$src"):cached"
      done <<< "$EXISTING_EXTRA_SOURCES"
      # Add the new directory
      echo "      - ${ATTACH_DIR}:/extra/${ATTACH_NAME}:cached"
    } > "$OVERRIDE_FILE"

    # Recreate container
    log "Stopping container..."
    docker compose --project-name moat \
      -f "$REPO_DIR/docker-compose.yml" \
      -f "$SERVICES_FILE" \
      -f "$OVERRIDE_FILE" down 2>/dev/null || true

    log "Starting container with new mount..."
    export MOAT_WORKSPACE="$ATTACH_WORKSPACE"
    devcontainer up \
      --workspace-folder "$ATTACH_WORKSPACE" \
      --config "$REPO_DIR/devcontainer.json"

    log "Container restarted with ${BOLD}/extra/$ATTACH_NAME${RESET}"
    log "Resume your session: ${BOLD}moat --resume${RESET}"
  fi
  exit 0
fi

if [ "${1:-}" = "detach" ]; then
  shift
  if ! command -v mutagen &>/dev/null; then
    err "mutagen is not installed."
    exit 1
  fi
  if [ -z "${1:-}" ]; then
    err "Usage: moat detach <dir|--all>"
    exit 1
  fi

  if [ "$1" = "--all" ]; then
    mutagen sync terminate --label-selector moat=true 2>/dev/null || true
    log "All moat sync sessions terminated."
  else
    DETACH_NAME="$(basename "$1")"
    if ! mutagen sync terminate --label-selector "moat=true,moat-dir=$DETACH_NAME" 2>/dev/null; then
      err "No sync session found for '$DETACH_NAME'."
      exit 1
    fi
    log "Detached $DETACH_NAME"
  fi
  exit 0
fi

if [ "${1:-}" = "update" ]; then
  shift
  BUILD_ARGS=()
  if [ "${1:-}" = "--version" ] && [ -n "${2:-}" ]; then
    BUILD_ARGS+=(--build-arg "CLAUDE_CODE_VERSION=$2")
    log "Rebuilding with Claude Code v$2..."
  else
    log "Pulling latest changes..."
    git -C "$REPO_DIR" pull --ff-only
    log "Rebuilding image (no-cache)..."
  fi
  # Stop running containers before rebuild
  docker compose --project-name moat \
    -f "$REPO_DIR/docker-compose.yml" \
    -f "$SERVICES_FILE" \
    -f "$OVERRIDE_FILE" down 2>/dev/null || true
  # Copy token again after pull (in case .gitignore cleaned it)
  ensure_token_in_repo
  # Ensure services placeholder exists
  if [ ! -f "$SERVICES_FILE" ]; then
    printf 'services:\n  devcontainer: {}\n' > "$SERVICES_FILE"
  fi
  docker compose --project-name moat \
    -f "$REPO_DIR/docker-compose.yml" \
    -f "$SERVICES_FILE" \
    -f "$OVERRIDE_FILE" build --no-cache ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
  log "Update complete."
  exit 0
fi

# Handle plan subcommand — inject read-only tool restriction
if [ "${1:-}" = "plan" ]; then
  shift
  set -- --allowedTools "Read,Grep,Glob,Task,WebFetch,WebSearch" "$@"
fi

# First arg is workspace path if it's a directory, otherwise default to cwd
if [ $# -gt 0 ] && [ -d "$1" ]; then
  WORKSPACE="$(cd "$1" && pwd)"
  shift
else
  WORKSPACE="$(pwd)"
fi

# Parse --add-dir flags and collect remaining claude args
EXTRA_DIRS=()
CLAUDE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --add-dir)
      if [ -n "${2:-}" ] && [ -d "$2" ]; then
        EXTRA_DIRS+=("$(cd "$2" && pwd)")
        shift 2
      else
        err "ERROR: --add-dir requires a valid directory path"
        exit 1
      fi
      ;;
    *)
      CLAUDE_ARGS+=("$1")
      shift
      ;;
  esac
done

export MOAT_WORKSPACE="$WORKSPACE"

# Generate docker-compose override for extra directories
if [ ${#EXTRA_DIRS[@]} -gt 0 ]; then
  {
    echo "services:"
    echo "  devcontainer:"
    echo "    volumes:"
    for dir in "${EXTRA_DIRS[@]}"; do
      echo "      - ${dir}:/extra/$(basename "$dir"):cached"
    done
  } > "$OVERRIDE_FILE"
  log "Extra directories:"
  for dir in "${EXTRA_DIRS[@]}"; do
    echo -e "  ${DIM}$dir -> /extra/$(basename "$dir")${RESET}"
  done
else
  printf 'services:\n  devcontainer: {}\n' > "$OVERRIDE_FILE"
fi

# Generate per-project config (services, squid, env) from .moat.yml
if command -v node &>/dev/null; then
  PROJECT_META=$(node "$REPO_DIR/generate-project-config.mjs" \
    --workspace "$WORKSPACE" \
    --repo "$REPO_DIR" 2>/dev/null) || PROJECT_META='{}'
  # Log services/domains if present (jq is available on the host)
  if command -v jq &>/dev/null; then
    SVC_NAMES=$(echo "$PROJECT_META" | jq -r 'select(.has_services) | .service_names | join(", ")' 2>/dev/null)
    [ -n "$SVC_NAMES" ] && log "Project services: ${DIM}${SVC_NAMES}${RESET}"
    EXTRA_DOMS=$(echo "$PROJECT_META" | jq -r 'select(.extra_domains | length > 0) | .extra_domains | join(", ")' 2>/dev/null)
    [ -n "$EXTRA_DOMS" ] && log "Extra domains: ${DIM}${EXTRA_DOMS}${RESET}"
  fi
else
  # No node available — ensure placeholder files exist
  if [ ! -f "$SERVICES_FILE" ]; then
    printf 'services:\n  devcontainer: {}\n' > "$SERVICES_FILE"
  fi
  cp "$REPO_DIR/squid.conf" "$REPO_DIR/squid-runtime.conf" 2>/dev/null || true
fi

# Build claude --add-dir flags for extra directories
CLAUDE_ADD_DIRS=()
if [ ${#EXTRA_DIRS[@]} -gt 0 ]; then
  for dir in "${EXTRA_DIRS[@]}"; do
    CLAUDE_ADD_DIRS+=(--add-dir "/extra/$(basename "$dir")")
  done
fi

cleanup_proxy() {
  log "Stopping tool proxy..."
  if command -v mutagen &>/dev/null; then
    mutagen sync terminate --label-selector moat=true 2>/dev/null || true
  fi
  if [ -f "$PROXY_PIDFILE" ]; then
    kill "$(cat "$PROXY_PIDFILE")" 2>/dev/null || true
    rm -f "$PROXY_PIDFILE"
  fi
  lsof -ti :9876 2>/dev/null | xargs kill 2>/dev/null || true
}

# On exit: stop tool proxy, leave containers running for reuse
trap cleanup_proxy EXIT

# Check if containers are already running with the same workspace
container_running() {
  docker compose --project-name moat \
    -f "$REPO_DIR/docker-compose.yml" \
    -f "$SERVICES_FILE" \
    -f "$OVERRIDE_FILE" ps --status running --format '{{.Name}}' 2>/dev/null \
    | grep -q devcontainer || return 1

  # Verify the running container was started for the same workspace
  local current_workspace
  current_workspace=$(docker inspect moat-devcontainer-1 \
    --format '{{index .Config.Labels "devcontainer.local_folder"}}' 2>/dev/null) || return 1
  [ "$current_workspace" = "$WORKSPACE" ]
}

mounts_match() {
  local current_mounts
  current_mounts=$(docker inspect moat-devcontainer-1 \
    --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}}{{"\n"}}{{end}}{{end}}' 2>/dev/null \
    | grep '^/extra/' | sort) || return 1

  local expected_mounts=""
  if [ ${#EXTRA_DIRS[@]} -gt 0 ]; then
    for dir in "${EXTRA_DIRS[@]}"; do
      expected_mounts+="/extra/$(basename "$dir")"$'\n'
    done
    expected_mounts=$(echo "$expected_mounts" | sed '/^$/d' | sort)
  fi

  [ "$current_mounts" = "$expected_mounts" ]
}

# Start or reuse tool proxy
if curl -sf http://127.0.0.1:9876/health &>/dev/null; then
  log "Tool proxy already running"
else
  # Kill any stale proxy first
  cleanup_proxy 2>/dev/null
  log "Starting tool proxy..."
  MOAT_TOKEN_FILE="$DATA_DIR/.proxy-token" node "$REPO_DIR/tool-proxy.mjs" --workspace "$WORKSPACE" \
    </dev/null >"$PROXY_LOG" 2>&1 &
  PROXY_PID=$!
  echo "$PROXY_PID" > "$PROXY_PIDFILE"
  sleep 1

  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    err "Tool proxy failed to start:"
    cat "$PROXY_LOG"
    exit 1
  fi
  log "Tool proxy running ${DIM}(PID $PROXY_PID)${RESET}"
fi

# Ensure token is in repo for devcontainer build context
ensure_token_in_repo

# Start or reuse container
if container_running; then
  if mounts_match; then
    log "Reusing running container"
  else
    log "Extra directories changed — recreating container..."
    docker compose --project-name moat \
      -f "$REPO_DIR/docker-compose.yml" \
      -f "$SERVICES_FILE" \
      -f "$OVERRIDE_FILE" down 2>/dev/null || true
    log "Starting devcontainer..."
    devcontainer up \
      --workspace-folder "$WORKSPACE" \
      --config "$REPO_DIR/devcontainer.json"
  fi
else
  # Tear down any container running for a different workspace
  if docker compose --project-name moat \
    -f "$REPO_DIR/docker-compose.yml" \
    -f "$SERVICES_FILE" \
    -f "$OVERRIDE_FILE" ps --status running --format '{{.Name}}' 2>/dev/null \
    | grep -q devcontainer; then
    log "Workspace changed — tearing down previous container..."
    docker compose --project-name moat \
      -f "$REPO_DIR/docker-compose.yml" \
      -f "$SERVICES_FILE" \
      -f "$OVERRIDE_FILE" down 2>/dev/null || true
  fi
  log "Starting devcontainer..."
  devcontainer up \
    --workspace-folder "$WORKSPACE" \
    --config "$REPO_DIR/devcontainer.json"
fi

# Execute Claude Code (blocks until exit)
log "Launching Claude Code..."
devcontainer exec \
  --workspace-folder "$WORKSPACE" \
  --config "$REPO_DIR/devcontainer.json" \
  claude --dangerously-skip-permissions ${CLAUDE_ADD_DIRS[@]+"${CLAUDE_ADD_DIRS[@]}"} ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}
