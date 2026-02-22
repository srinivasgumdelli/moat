#!/bin/bash
# Background agent manager for Moat
# Spawns read-only Claude Code agents that run in the background.

set -euo pipefail

AGENT_DIR="/tmp/moat-agents"

usage() {
  cat <<'EOF'
Usage: agent <command> [options]

Commands:
  run [--name <name>] "prompt"   Spawn a read-only background agent
  list                           Show all agents (id, name, pid, status, prompt)
  log <id>                       Show agent output (supports partial ID)
  kill <id>                      Terminate an agent
  kill --all                     Terminate all agents
EOF
  exit 1
}

gen_id() {
  head -c 4 /dev/urandom | xxd -p
}

resolve_id() {
  local partial="$1"
  local matches=()
  if [ ! -d "$AGENT_DIR" ]; then
    echo "No agents found." >&2
    exit 1
  fi
  for d in "$AGENT_DIR"/*/; do
    [ -d "$d" ] || continue
    local id
    id=$(basename "$d")
    if [[ "$id" == "$partial"* ]]; then
      matches+=("$id")
    fi
  done
  if [ ${#matches[@]} -eq 0 ]; then
    echo "No agent matching '$partial'." >&2
    exit 1
  elif [ ${#matches[@]} -gt 1 ]; then
    echo "Ambiguous ID '$partial' — matches: ${matches[*]}" >&2
    exit 1
  fi
  echo "${matches[0]}"
}

check_status() {
  local dir="$1"
  local meta="$dir/meta.json"
  [ -f "$meta" ] || return
  local pid status
  pid=$(jq -r '.pid' "$meta")
  status=$(jq -r '.status' "$meta")
  if [ "$status" = "running" ] && ! kill -0 "$pid" 2>/dev/null; then
    local exit_code=0
    if [ -f "$dir/exit_code" ]; then
      exit_code=$(cat "$dir/exit_code")
    fi
    if [ "$exit_code" -eq 0 ]; then
      jq '.status = "done"' "$meta" > "$meta.tmp" && mv "$meta.tmp" "$meta"
    else
      jq '.status = "failed"' "$meta" > "$meta.tmp" && mv "$meta.tmp" "$meta"
    fi
  fi
}

cmd_run() {
  local name="" prompt=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --name)
        name="$2"
        shift 2
        ;;
      *)
        prompt="$1"
        shift
        ;;
    esac
  done

  if [ -z "$prompt" ]; then
    echo "Usage: agent run [--name <name>] \"prompt\"" >&2
    exit 1
  fi

  local id
  id=$(gen_id)
  local dir="$AGENT_DIR/$id"
  mkdir -p "$dir"

  [ -z "$name" ] && name="agent-${id:0:4}"

  local allowed_tools="Read,Grep,Glob,Task,WebFetch,WebSearch"
  allowed_tools+=",mcp__ide_tools__run_tests,mcp__ide_tools__run_diagnostics"
  allowed_tools+=",mcp__ide_tools__list_tests,mcp__ide_tools__get_project_info"
  allowed_tools+=",mcp__ide_lsp__lsp_hover,mcp__ide_lsp__lsp_definition"
  allowed_tools+=",mcp__ide_lsp__lsp_references,mcp__ide_lsp__lsp_diagnostics"
  allowed_tools+=",mcp__ide_lsp__lsp_symbols,mcp__ide_lsp__lsp_workspace_symbols"

  # Start the agent in the background
  (
    claude -p "$prompt" --dangerously-skip-permissions --allowedTools "$allowed_tools" \
      > "$dir/output.txt" 2>"$dir/stderr.txt"
    echo $? > "$dir/exit_code"
  ) &
  local pid=$!
  disown "$pid"

  # Write metadata
  local started_at
  started_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  cat > "$dir/meta.json" <<METAEOF
{
  "id": "$id",
  "name": "$name",
  "prompt": $(printf '%s' "$prompt" | jq -Rs .),
  "pid": $pid,
  "status": "running",
  "started_at": "$started_at"
}
METAEOF

  echo "$id  $name  (pid $pid)"
}

cmd_list() {
  if [ ! -d "$AGENT_DIR" ] || [ -z "$(ls -A "$AGENT_DIR" 2>/dev/null)" ]; then
    echo "No agents."
    return
  fi

  printf "%-10s %-16s %-8s %-8s %s\n" "ID" "NAME" "PID" "STATUS" "PROMPT"
  printf "%-10s %-16s %-8s %-8s %s\n" "---" "---" "---" "---" "---"

  for dir in "$AGENT_DIR"/*/; do
    [ -d "$dir" ] || continue
    check_status "$dir"
    local meta="$dir/meta.json"
    [ -f "$meta" ] || continue
    local id name pid status prompt_snippet
    id=$(jq -r '.id' "$meta")
    name=$(jq -r '.name' "$meta")
    pid=$(jq -r '.pid' "$meta")
    status=$(jq -r '.status' "$meta")
    prompt_snippet=$(jq -r '.prompt[:50]' "$meta")
    printf "%-10s %-16s %-8s %-8s %s\n" "${id:0:8}" "$name" "$pid" "$status" "$prompt_snippet"
  done
}

cmd_log() {
  if [ $# -lt 1 ]; then
    echo "Usage: agent log <id>" >&2
    exit 1
  fi
  local id
  id=$(resolve_id "$1")
  local dir="$AGENT_DIR/$id"
  check_status "$dir"

  if [ -f "$dir/output.txt" ]; then
    cat "$dir/output.txt"
  else
    echo "(no output yet)"
  fi
}

cmd_kill() {
  if [ $# -lt 1 ]; then
    echo "Usage: agent kill <id>  or  agent kill --all" >&2
    exit 1
  fi

  if [ "$1" = "--all" ]; then
    if [ ! -d "$AGENT_DIR" ] || [ -z "$(ls -A "$AGENT_DIR" 2>/dev/null)" ]; then
      echo "No agents."
      return
    fi
    for dir in "$AGENT_DIR"/*/; do
      [ -d "$dir" ] || continue
      local meta="$dir/meta.json"
      [ -f "$meta" ] || continue
      local pid status id
      pid=$(jq -r '.pid' "$meta")
      status=$(jq -r '.status' "$meta")
      id=$(jq -r '.id' "$meta")
      if [ "$status" = "running" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        jq '.status = "killed"' "$meta" > "$meta.tmp" && mv "$meta.tmp" "$meta"
        echo "Killed $id (pid $pid)"
      fi
    done
    return
  fi

  local id
  id=$(resolve_id "$1")
  local dir="$AGENT_DIR/$id"
  local meta="$dir/meta.json"
  local pid
  pid=$(jq -r '.pid' "$meta")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    jq '.status = "killed"' "$meta" > "$meta.tmp" && mv "$meta.tmp" "$meta"
    echo "Killed $id (pid $pid)"
  else
    echo "Agent $id is not running."
  fi
}

cmd_count() {
  local count=0
  if [ -d "$AGENT_DIR" ]; then
    for dir in "$AGENT_DIR"/*/; do
      [ -d "$dir" ] || continue
      local meta="$dir/meta.json"
      [ -f "$meta" ] || continue
      local pid status
      pid=$(jq -r '.pid' "$meta")
      status=$(jq -r '.status' "$meta")
      if [ "$status" = "running" ] && kill -0 "$pid" 2>/dev/null; then
        count=$((count + 1))
      fi
    done
  fi
  echo "$count"
}

# --- Main ---
[ $# -lt 1 ] && usage

cmd="$1"
shift

case "$cmd" in
  run)   cmd_run "$@" ;;
  list)  cmd_list ;;
  log)   cmd_log "$@" ;;
  kill)  cmd_kill "$@" ;;
  count) cmd_count ;;
  *)     usage ;;
esac
