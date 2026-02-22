#!/bin/bash
# Claude Code status line hook for Moat
# Reads JSON from stdin, enriches with beads task + agent count, outputs formatted line.

set -euo pipefail

# Read JSON from stdin
input=$(cat)

# Extract fields from Claude Code's JSON
model=$(echo "$input" | jq -r '.model.display_name // empty' 2>/dev/null)
ctx_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty' 2>/dev/null)

parts=()

# Model name
if [ -n "$model" ]; then
  parts+=("$model")
fi

# Current beads task — parse issues.jsonl directly
task_title=""
if [ -f /workspace/.beads/issues.jsonl ]; then
  # Try in_progress first, then fall back to most recent open
  task_title=$(jq -r 'select(.status == "in_progress") | .title' /workspace/.beads/issues.jsonl 2>/dev/null | tail -1)
  if [ -z "$task_title" ]; then
    task_title=$(jq -r 'select(.status == "open") | .title' /workspace/.beads/issues.jsonl 2>/dev/null | tail -1)
  fi
fi
if [ -n "$task_title" ]; then
  # Truncate to 30 chars
  if [ ${#task_title} -gt 30 ]; then
    task_title="${task_title:0:27}..."
  fi
  parts+=("task: $task_title")
fi

# Running agent count
agent_count=0
if [ -d /tmp/moat-agents ]; then
  for dir in /tmp/moat-agents/*/; do
    [ -d "$dir" ] || continue
    meta="$dir/meta.json"
    [ -f "$meta" ] || continue
    pid=$(jq -r '.pid' "$meta" 2>/dev/null) || continue
    status=$(jq -r '.status' "$meta" 2>/dev/null) || continue
    if [ "$status" = "running" ] && kill -0 "$pid" 2>/dev/null; then
      agent_count=$((agent_count + 1))
    fi
  done
fi
if [ "$agent_count" -gt 0 ]; then
  parts+=("agents: $agent_count")
fi

# Context usage
if [ -n "$ctx_pct" ]; then
  # Round to integer
  ctx_int=$(printf '%.0f' "$ctx_pct" 2>/dev/null || echo "$ctx_pct")
  parts+=("ctx: ${ctx_int}%")
fi

# Cost
if [ -n "$cost" ]; then
  parts+=("\$${cost}")
fi

# Join with " | "
output=""
for i in "${!parts[@]}"; do
  if [ "$i" -gt 0 ]; then
    output+="  |  "
  fi
  output+="${parts[$i]}"
done

echo "$output"
