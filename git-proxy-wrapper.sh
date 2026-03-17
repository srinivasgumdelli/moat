#!/bin/bash
# git-proxy-wrapper.sh — routes git ops through host tool proxy
# For paths outside /workspace and /extra, uses real git directly
# Also: quality gate enforcement (pre-push) and auto-checkpointing (pre-risky-op)

PROXY_URL="http://host.docker.internal:9876"
PROXY_TOKEN=$(cat /etc/tool-proxy-token 2>/dev/null)
REAL_GIT="/usr/bin/git"
CWD="$(pwd)"

should_use_proxy() {
  [ -n "$PROXY_TOKEN" ] || return 1
  case "$CWD" in
    /workspace|/workspace/*|/extra|/extra/*) return 0 ;;
    *) return 1 ;;
  esac
}

if ! should_use_proxy; then
  exec "$REAL_GIT" "$@"
fi

# --- Auto-checkpoint before risky operations ---

is_risky_op() {
  case "$1" in
    reset|clean|rebase) return 0 ;;
    checkout)
      shift
      for a in "$@"; do
        case "$a" in
          .|--) return 0 ;;
        esac
      done
      return 1 ;;
    stash)
      case "$2" in
        drop|clear) return 0 ;;
      esac
      return 1 ;;
    branch)
      case "$2" in
        -D) return 0 ;;
      esac
      return 1 ;;
    *) return 1 ;;
  esac
}

maybe_checkpoint() {
  if ! "$REAL_GIT" diff --quiet 2>/dev/null || ! "$REAL_GIT" diff --cached --quiet 2>/dev/null; then
    "$REAL_GIT" add -A 2>/dev/null
    "$REAL_GIT" commit -m "[moat-checkpoint] auto-save before $*" --no-verify 2>/dev/null
    echo "[moat] Checkpoint saved before: $*" >&2
  fi
}

if [ "${MOAT_SKIP_CHECKPOINT:-}" != "1" ] && is_risky_op "$@"; then
  maybe_checkpoint "$@"
fi

# --- Quality gate before push ---

if [ "$1" = "push" ]; then
  if [ -x /usr/local/bin/quality-gate ]; then
    /usr/local/bin/quality-gate "$CWD" || exit $?
  fi
fi

# --- Proxy the git command to host ---

# Serialize arguments to JSON
if [ $# -eq 0 ]; then
  ARGS_JSON='[]'
else
  ARGS_JSON=$(printf '%s\0' "$@" | jq -Rs '[split("\u0000")[] | select(length > 0)]')
fi
JSON_PAYLOAD=$(jq -n --argjson args "$ARGS_JSON" --arg cwd "$CWD" --arg hash "${MOAT_WORKSPACE_HASH:-}" \
  '{args: $args, cwd: $cwd, workspace_hash: $hash}')

RESPONSE=$(curl -s -X POST "${PROXY_URL}/git" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${PROXY_TOKEN}" \
  -d "$JSON_PAYLOAD" 2>/dev/null)

CURL_EXIT=$?
if [ $CURL_EXIT -ne 0 ]; then
  echo "[git-proxy] ERROR: Tool proxy unreachable (is it running on the host?)" >&2
  exit 128
fi

# Verify response is JSON before parsing
if ! echo "$RESPONSE" | jq -e '.exitCode' >/dev/null 2>&1; then
  echo "[git-proxy] ERROR: Tool proxy unreachable or returned invalid response" >&2
  exit 128
fi

STDOUT=$(echo "$RESPONSE" | jq -r '.stdout // empty')
STDERR=$(echo "$RESPONSE" | jq -r '.stderr // empty')
EXIT_CODE=$(echo "$RESPONSE" | jq -r '.exitCode // 1')

[ -n "$STDOUT" ] && printf '%s' "$STDOUT"
[ -n "$STDERR" ] && printf '%s' "$STDERR" >&2
exit "$EXIT_CODE"
