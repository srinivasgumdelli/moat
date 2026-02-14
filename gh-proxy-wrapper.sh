#!/bin/bash
# gh-proxy-wrapper.sh — proxies all gh commands to host tool proxy

PROXY_URL="http://host.docker.internal:9876"
PROXY_TOKEN=$(cat /etc/tool-proxy-token 2>/dev/null)

if [ -z "$PROXY_TOKEN" ]; then
  echo "[gh-proxy] ERROR: /etc/tool-proxy-token not found" >&2
  exit 1
fi

# Serialize arguments to JSON
if [ $# -eq 0 ]; then
  ARGS_JSON='[]'
else
  ARGS_JSON=$(printf '%s\0' "$@" | jq -Rs '[split("\u0000")[] | select(length > 0)]')
fi

CWD="$(pwd)"
JSON_PAYLOAD=$(jq -n --argjson args "$ARGS_JSON" --arg cwd "$CWD" \
  '{args: $args, cwd: $cwd}')

RESPONSE=$(curl -s -X POST "${PROXY_URL}/gh" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${PROXY_TOKEN}" \
  -d "$JSON_PAYLOAD" 2>/dev/null)

CURL_EXIT=$?
if [ $CURL_EXIT -ne 0 ]; then
  echo "[gh-proxy] ERROR: Tool proxy unreachable (is it running on the host?)" >&2
  exit 1
fi

# Verify response is JSON before parsing
if ! echo "$RESPONSE" | jq -e '.exitCode' >/dev/null 2>&1; then
  echo "[gh-proxy] ERROR: Tool proxy unreachable or returned invalid response" >&2
  exit 1
fi

STDOUT=$(echo "$RESPONSE" | jq -r '.stdout // empty')
STDERR=$(echo "$RESPONSE" | jq -r '.stderr // empty')
EXIT_CODE=$(echo "$RESPONSE" | jq -r '.exitCode // 1')

[ -n "$STDOUT" ] && printf '%s' "$STDOUT"
[ -n "$STDERR" ] && printf '%s' "$STDERR" >&2
exit "$EXIT_CODE"
