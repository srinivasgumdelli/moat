#!/bin/bash
# terraform-proxy-wrapper.sh — routes /workspace terraform ops through host tool proxy
# For paths outside /workspace, uses real terraform directly
# Plan-only mode: apply, destroy, and other mutating commands are blocked by the proxy

PROXY_URL="http://host.docker.internal:9876"
PROXY_TOKEN=$(cat /etc/tool-proxy-token 2>/dev/null)
REAL_TERRAFORM="/usr/bin/terraform"
CWD="$(pwd)"

should_use_proxy() {
  [ -n "$PROXY_TOKEN" ] || return 1
  case "$CWD" in
    /workspace|/workspace/*|/extra|/extra/*) return 0 ;;
    *) return 1 ;;
  esac
}

if ! should_use_proxy; then
  exec "$REAL_TERRAFORM" "$@"
fi

# Serialize arguments to JSON
if [ $# -eq 0 ]; then
  ARGS_JSON='[]'
else
  ARGS_JSON=$(printf '%s\0' "$@" | jq -Rs '[split("\u0000")[] | select(length > 0)]')
fi
JSON_PAYLOAD=$(jq -n --argjson args "$ARGS_JSON" --arg cwd "$CWD" --arg hash "${MOAT_WORKSPACE_HASH:-}" \
  '{args: $args, cwd: $cwd, workspace_hash: $hash}')

RESPONSE=$(curl -s --max-time 300 -X POST "${PROXY_URL}/terraform" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${PROXY_TOKEN}" \
  -d "$JSON_PAYLOAD" 2>/dev/null)

CURL_EXIT=$?
if [ $CURL_EXIT -ne 0 ]; then
  echo "[terraform-proxy] ERROR: Tool proxy unreachable (is it running on the host?)" >&2
  exit 128
fi

# Verify response is JSON before parsing
if ! echo "$RESPONSE" | jq -e '.exitCode' >/dev/null 2>&1; then
  echo "[terraform-proxy] ERROR: Tool proxy unreachable or returned invalid response" >&2
  exit 128
fi

# Check if command was blocked by allowlist
BLOCKED=$(echo "$RESPONSE" | jq -r '.blocked // empty')
if [ "$BLOCKED" = "true" ]; then
  REASON=$(echo "$RESPONSE" | jq -r '.reason // "Command blocked by Moat policy"')
  echo "[terraform-proxy] BLOCKED: $REASON" >&2
  exit 126
fi

STDOUT=$(echo "$RESPONSE" | jq -r '.stdout // empty')
STDERR=$(echo "$RESPONSE" | jq -r '.stderr // empty')
EXIT_CODE=$(echo "$RESPONSE" | jq -r '.exitCode // 1')

[ -n "$STDOUT" ] && printf '%s' "$STDOUT"
[ -n "$STDERR" ] && printf '%s' "$STDERR" >&2
exit "$EXIT_CODE"
