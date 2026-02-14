#!/bin/bash
# Moat — sandboxed Claude Code launcher
# Usage: moat.sh [workspace_path] [--add-dir <path>...] [claude args...]
# Subcommands: doctor | update [--version X.Y.Z] | down | plan | uninstall

set -euo pipefail

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
    echo "[moat] Migrated proxy token to $DATA_DIR/.proxy-token"
  else
    openssl rand -hex 32 > "$DATA_DIR/.proxy-token"
    chmod 600 "$DATA_DIR/.proxy-token"
    echo "[moat] Generated new proxy token at $DATA_DIR/.proxy-token"
  fi
fi

# Helper: copy token into repo dir for Docker build context
ensure_token_in_repo() {
  cp "$DATA_DIR/.proxy-token" "$REPO_DIR/.proxy-token"
}

# --- doctor subcommand ---
if [ "${1:-}" = "doctor" ]; then
  echo "=============================="
  echo "Moat Doctor"
  echo "=============================="
  echo ""

  FAILS=0
  WARNS=0

  check_pass() { echo "  PASS: $1"; }
  check_warn() { echo "  WARN: $1"; WARNS=$((WARNS + 1)); }
  check_fail() { echo "  FAIL: $1"; FAILS=$((FAILS + 1)); }
  check_info() { echo "  INFO: $1"; }

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
    check_fail "~/.devcontainers/moat not found (run setup.sh)"
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

  echo ""
  if [ "$FAILS" -gt 0 ]; then
    echo "Result: $FAILS FAIL(s), $WARNS WARN(s)"
    exit 1
  elif [ "$WARNS" -gt 0 ]; then
    echo "Result: all checks passed, $WARNS WARN(s)"
    exit 0
  else
    echo "Result: all checks passed"
    exit 0
  fi
fi

# Handle subcommands
if [ "${1:-}" = "down" ]; then
  echo "[moat] Tearing down containers..."
  docker compose --project-name moat \
    -f "$REPO_DIR/docker-compose.yml" \
    -f "$OVERRIDE_FILE" down 2>/dev/null || true
  # Also stop tool proxy
  if [ -f "$PROXY_PIDFILE" ]; then
    kill "$(cat "$PROXY_PIDFILE")" 2>/dev/null || true
    rm -f "$PROXY_PIDFILE"
  fi
  lsof -ti :9876 2>/dev/null | xargs kill 2>/dev/null || true
  echo "[moat] Done."
  exit 0
fi

if [ "${1:-}" = "update" ]; then
  shift
  BUILD_ARGS=()
  if [ "${1:-}" = "--version" ] && [ -n "${2:-}" ]; then
    BUILD_ARGS+=(--build-arg "CLAUDE_CODE_VERSION=$2")
    echo "[moat] Rebuilding with Claude Code v$2..."
  else
    echo "[moat] Pulling latest changes..."
    git -C "$REPO_DIR" pull --ff-only
    echo "[moat] Rebuilding image (no-cache)..."
  fi
  # Stop running containers before rebuild
  docker compose --project-name moat \
    -f "$REPO_DIR/docker-compose.yml" \
    -f "$OVERRIDE_FILE" down 2>/dev/null || true
  # Copy token again after pull (in case .gitignore cleaned it)
  ensure_token_in_repo
  docker compose --project-name moat \
    -f "$REPO_DIR/docker-compose.yml" \
    -f "$OVERRIDE_FILE" build --no-cache ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
  echo "[moat] Update complete."
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
        echo "[moat] ERROR: --add-dir requires a valid directory path"
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
  echo "[moat] Extra directories:"
  for dir in "${EXTRA_DIRS[@]}"; do
    echo "[moat]   $dir -> /extra/$(basename "$dir")"
  done
else
  printf 'services:\n  devcontainer: {}\n' > "$OVERRIDE_FILE"
fi

# Build claude --add-dir flags for extra directories
CLAUDE_ADD_DIRS=()
if [ ${#EXTRA_DIRS[@]} -gt 0 ]; then
  for dir in "${EXTRA_DIRS[@]}"; do
    CLAUDE_ADD_DIRS+=(--add-dir "/extra/$(basename "$dir")")
  done
fi

cleanup_proxy() {
  echo "[moat] Stopping tool proxy..."
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
    -f "$OVERRIDE_FILE" ps --status running --format '{{.Name}}' 2>/dev/null \
    | grep -q devcontainer
}

# Start or reuse tool proxy
if curl -sf http://127.0.0.1:9876/health &>/dev/null; then
  echo "[moat] Tool proxy already running"
else
  # Kill any stale proxy first
  cleanup_proxy 2>/dev/null
  echo "[moat] Starting tool proxy..."
  MOAT_TOKEN_FILE="$DATA_DIR/.proxy-token" node "$REPO_DIR/tool-proxy.mjs" --workspace "$WORKSPACE" \
    </dev/null >"$PROXY_LOG" 2>&1 &
  PROXY_PID=$!
  echo "$PROXY_PID" > "$PROXY_PIDFILE"
  sleep 1

  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "[moat] ERROR: Tool proxy failed to start:"
    cat "$PROXY_LOG"
    exit 1
  fi
  echo "[moat] Tool proxy running (PID $PROXY_PID)"
fi

# Ensure token is in repo for devcontainer build context
ensure_token_in_repo

# Start or reuse container
if container_running; then
  echo "[moat] Reusing running container"
else
  echo "[moat] Starting devcontainer..."
  devcontainer up \
    --workspace-folder "$WORKSPACE" \
    --config "$REPO_DIR/devcontainer.json"
fi

# Execute Claude Code (blocks until exit)
echo "[moat] Launching Claude Code..."
devcontainer exec \
  --workspace-folder "$WORKSPACE" \
  --config "$REPO_DIR/devcontainer.json" \
  claude --dangerously-skip-permissions ${CLAUDE_ADD_DIRS[@]+"${CLAUDE_ADD_DIRS[@]}"} ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}
