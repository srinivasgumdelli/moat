#!/bin/bash
# Background agent manager for Moat
# Spawns read-only Claude Code agents in isolated Docker containers.
# All commands route through the host tool-proxy via HTTP.

set -euo pipefail

PROXY_URL="http://host.docker.internal:9876"
PROXY_TOKEN=$(cat /etc/tool-proxy-token 2>/dev/null || true)
WS_HASH="${MOAT_WORKSPACE_HASH:-}"

if [ -z "$PROXY_TOKEN" ]; then
  echo "[agent] ERROR: /etc/tool-proxy-token not found" >&2
  exit 1
fi

if [ -z "$WS_HASH" ]; then
  echo "[agent] ERROR: MOAT_WORKSPACE_HASH not set" >&2
  exit 1
fi

usage() {
  cat <<'EOF'
Usage: agent [--name <name>] <prompt>       Spawn a background agent
       agent list                           Show all agents
       agent log <id>                       Show agent output
       agent kill <id|--all>                Terminate agent(s)
       agent count                          Count running agents
       agent results                        Get completed agent output
       agent wait <id>                      Wait for agent to finish
EOF
  exit 1
}

api_get() {
  local path="$1"
  curl -s --max-time 310 -X GET "${PROXY_URL}${path}" \
    -H "Authorization: Bearer ${PROXY_TOKEN}" 2>/dev/null
}

api_post() {
  local path="$1"
  local data="$2"
  curl -s --max-time 10 -X POST "${PROXY_URL}${path}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${PROXY_TOKEN}" \
    -d "$data" 2>/dev/null
}

check_response() {
  local response="$1"
  if ! echo "$response" | jq -e '.success' >/dev/null 2>&1; then
    echo "[agent] ERROR: Tool proxy unreachable" >&2
    exit 1
  fi
  local success
  success=$(echo "$response" | jq -r '.success')
  if [ "$success" != "true" ]; then
    echo "[agent] ERROR: $(echo "$response" | jq -r '.error // "unknown error"')" >&2
    exit 1
  fi
}

cmd_run() {
  local name=""
  local -a words=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --name)
        name="$2"
        shift 2
        ;;
      *)
        words+=("$1")
        shift
        ;;
    esac
  done

  local prompt="${words[*]}"
  if [ -z "$prompt" ]; then
    echo "Usage: agent [--name <name>] <prompt>" >&2
    exit 1
  fi

  local payload
  if [ -n "$name" ]; then
    payload=$(jq -n --arg prompt "$prompt" --arg name "$name" --arg hash "$WS_HASH" \
      '{prompt: $prompt, name: $name, workspace_hash: $hash}')
  else
    payload=$(jq -n --arg prompt "$prompt" --arg hash "$WS_HASH" \
      '{prompt: $prompt, workspace_hash: $hash}')
  fi

  local response
  response=$(api_post "/agent/spawn" "$payload")
  check_response "$response"

  local id name_out
  id=$(echo "$response" | jq -r '.id')
  name_out=$(echo "$response" | jq -r '.name')
  echo "$id  $name_out"
}

cmd_list() {
  local response
  response=$(api_get "/agent/list?workspace_hash=${WS_HASH}")
  check_response "$response"

  local count
  count=$(echo "$response" | jq '.agents | length')

  if [ "$count" -eq 0 ]; then
    echo "No agents."
    return
  fi

  printf "%-10s %-16s %-8s %s\n" "ID" "NAME" "STATUS" "PROMPT"
  printf "%-10s %-16s %-8s %s\n" "---" "---" "---" "---"
  echo "$response" | jq -r '.agents[] | [.id[:8], .name, .status, .prompt[:50]] | @tsv' | \
    while IFS=$'\t' read -r id name status prompt; do
      printf "%-10s %-16s %-8s %s\n" "$id" "$name" "$status" "$prompt"
    done
}

cmd_log() {
  if [ $# -lt 1 ]; then
    echo "Usage: agent log <id>" >&2
    exit 1
  fi
  local response
  response=$(api_get "/agent/log/${1}?workspace_hash=${WS_HASH}")
  check_response "$response"

  echo "$response" | jq -r '.log // "(no output yet)"'
}

cmd_kill() {
  if [ $# -lt 1 ]; then
    echo "Usage: agent kill <id>  or  agent kill --all" >&2
    exit 1
  fi

  local target="$1"
  local payload
  payload=$(jq -n --arg hash "$WS_HASH" '{workspace_hash: $hash}')

  local response
  response=$(api_post "/agent/kill/${target}" "$payload")
  check_response "$response"

  echo "$response" | jq -r '.message // "Done"'
}

cmd_count() {
  local response
  response=$(api_get "/agent/list?workspace_hash=${WS_HASH}" 2>/dev/null) || true

  if ! echo "$response" | jq -e '.success' >/dev/null 2>&1; then
    echo "0"
    return
  fi
  echo "$response" | jq '[.agents[] | select(.status == "running")] | length'
}

cmd_results() {
  local response
  response=$(api_get "/agent/results?workspace_hash=${WS_HASH}")
  check_response "$response"

  local count
  count=$(echo "$response" | jq '.results | length')

  if [ "$count" -eq 0 ]; then
    echo "No completed agents."
    return
  fi

  echo "$response" | jq -r '.results[] | "=== \(.name) (\(.id[:8])) — \(.status) ===\n\(.log)\n"'
}

cmd_wait() {
  if [ $# -lt 1 ]; then
    echo "Usage: agent wait <id>" >&2
    exit 1
  fi
  local response
  response=$(api_get "/agent/wait/${1}?workspace_hash=${WS_HASH}")
  check_response "$response"

  echo "$response" | jq -r '.log // "(no output)"'
}

# --- Main ---
[ $# -lt 1 ] && usage

cmd="$1"
shift

case "$cmd" in
  run)     cmd_run "$@" ;;
  list)    cmd_list ;;
  log)     cmd_log "$@" ;;
  kill)    cmd_kill "$@" ;;
  count)   cmd_count ;;
  results) cmd_results ;;
  wait)    cmd_wait "$@" ;;
  *)       cmd_run "$cmd" "$@" ;;
esac
