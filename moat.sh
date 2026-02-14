#!/bin/bash
# Moat — sandboxed Claude Code launcher
# Usage: moat.sh [workspace_path] [--add-dir <path>...] [claude args...]
# Plan mode: moat.sh --allowedTools "Read,Grep,Glob,Task,WebFetch,WebSearch"

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
DATA_DIR="$HOME/.local/share/moat-data"
OVERRIDE_FILE="$REPO_DIR/docker-compose.extra-dirs.yml"
PROXY_PIDFILE="/tmp/moat-tool-proxy.pid"
PROXY_LOG="/tmp/moat-tool-proxy.log"

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

# Copy token into repo dir for Docker build context
cp "$DATA_DIR/.proxy-token" "$REPO_DIR/.proxy-token"

# Handle subcommands
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
  # Copy token again after pull (in case .gitignore cleaned it)
  cp "$DATA_DIR/.proxy-token" "$REPO_DIR/.proxy-token"
  docker compose --project-name moat \
    -f "$REPO_DIR/docker-compose.yml" \
    -f "$OVERRIDE_FILE" build --no-cache "${BUILD_ARGS[@]}"
  echo "[moat] Update complete."
  exit 0
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
for dir in "${EXTRA_DIRS[@]}"; do
  CLAUDE_ADD_DIRS+=(--add-dir "/extra/$(basename "$dir")")
done

cleanup() {
  echo "[moat] Cleaning up..."
  if [ -f "$PROXY_PIDFILE" ]; then
    kill "$(cat "$PROXY_PIDFILE")" 2>/dev/null || true
    rm -f "$PROXY_PIDFILE"
  fi
  lsof -ti :9876 2>/dev/null | xargs kill 2>/dev/null || true
  docker compose --project-name moat \
    -f "$REPO_DIR/docker-compose.yml" \
    -f "$OVERRIDE_FILE" down 2>/dev/null || true
}

# Cleanup on exit (ephemeral)
trap cleanup EXIT

# Teardown any previous session
cleanup

# Start tool proxy
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

# Start devcontainer
echo "[moat] Starting devcontainer..."
devcontainer up \
  --workspace-folder "$WORKSPACE" \
  --config "$REPO_DIR/devcontainer.json"

# Execute Claude Code (blocks until exit)
echo "[moat] Launching Claude Code..."
devcontainer exec \
  --workspace-folder "$WORKSPACE" \
  --config "$REPO_DIR/devcontainer.json" \
  claude --dangerously-skip-permissions ${CLAUDE_ADD_DIRS[@]+"${CLAUDE_ADD_DIRS[@]}"} ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}
