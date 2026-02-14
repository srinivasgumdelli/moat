#!/bin/bash
# Anvil — sandboxed Claude Code launcher
# Usage: anvil.sh [workspace_path] [--add-dir <path>...] [claude args...]
# Plan mode: anvil.sh --allowedTools "Read,Grep,Glob,Task,WebFetch,WebSearch"

set -euo pipefail

CONFIG_DIR="$HOME/.devcontainers/anvil"
OVERRIDE_FILE="$CONFIG_DIR/docker-compose.extra-dirs.yml"
PROXY_PIDFILE="/tmp/anvil-tool-proxy.pid"
PROXY_LOG="/tmp/anvil-tool-proxy.log"

# Handle subcommands
if [ "${1:-}" = "update" ]; then
  shift
  BUILD_ARGS=()
  if [ "${1:-}" = "--version" ] && [ -n "${2:-}" ]; then
    BUILD_ARGS+=(--build-arg "CLAUDE_CODE_VERSION=$2")
    echo "[anvil] Rebuilding with Claude Code v$2..."
  else
    echo "[anvil] Rebuilding image (no-cache)..."
  fi
  docker compose --project-name anvil \
    -f "$CONFIG_DIR/docker-compose.yml" build --no-cache "${BUILD_ARGS[@]}"
  echo "[anvil] Update complete."
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
        echo "[anvil] ERROR: --add-dir requires a valid directory path"
        exit 1
      fi
      ;;
    *)
      CLAUDE_ARGS+=("$1")
      shift
      ;;
  esac
done

export ANVIL_WORKSPACE="$WORKSPACE"

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
  echo "[anvil] Extra directories:"
  for dir in "${EXTRA_DIRS[@]}"; do
    echo "[anvil]   $dir -> /extra/$(basename "$dir")"
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
  echo "[anvil] Cleaning up..."
  if [ -f "$PROXY_PIDFILE" ]; then
    kill "$(cat "$PROXY_PIDFILE")" 2>/dev/null || true
    rm -f "$PROXY_PIDFILE"
  fi
  lsof -ti :9876 2>/dev/null | xargs kill 2>/dev/null || true
  docker compose --project-name anvil \
    -f "$CONFIG_DIR/docker-compose.yml" \
    -f "$OVERRIDE_FILE" down 2>/dev/null || true
}

# Cleanup on exit (ephemeral)
trap cleanup EXIT

# Teardown any previous session
cleanup

# Start tool proxy
echo "[anvil] Starting tool proxy..."
node "$CONFIG_DIR/tool-proxy.mjs" --workspace "$WORKSPACE" \
  </dev/null >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!
echo "$PROXY_PID" > "$PROXY_PIDFILE"
sleep 1

if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "[anvil] ERROR: Tool proxy failed to start:"
  cat "$PROXY_LOG"
  exit 1
fi
echo "[anvil] Tool proxy running (PID $PROXY_PID)"

# Start devcontainer
echo "[anvil] Starting devcontainer..."
devcontainer up \
  --workspace-folder "$WORKSPACE" \
  --config "$CONFIG_DIR/devcontainer.json"

# Execute Claude Code (blocks until exit)
echo "[anvil] Launching Claude Code..."
devcontainer exec \
  --workspace-folder "$WORKSPACE" \
  --config "$CONFIG_DIR/devcontainer.json" \
  claude --dangerously-skip-permissions ${CLAUDE_ADD_DIRS[@]+"${CLAUDE_ADD_DIRS[@]}"} ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}
