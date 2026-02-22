#!/bin/bash
# Claude Code status line hook for Moat
# Reads JSON from stdin, enriches with beads task + agent count, outputs compact line.

# No set -euo pipefail — status line must be resilient; partial output beats no output.

# Read JSON from stdin
input=$(cat 2>/dev/null || true)

# Extract fields from Claude Code's JSON (all optional — fail gracefully)
ctx_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty' 2>/dev/null || true)
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty' 2>/dev/null || true)

parts=()

# Current beads task — parse issues.jsonl directly
task_title=""
if [ -f /workspace/.beads/issues.jsonl ]; then
  task_title=$(jq -r 'select(.status == "in_progress") | .title' /workspace/.beads/issues.jsonl 2>/dev/null | tail -1 || true)
  if [ -z "$task_title" ]; then
    task_title=$(jq -r 'select(.status == "open") | .title' /workspace/.beads/issues.jsonl 2>/dev/null | tail -1 || true)
  fi
fi
if [ -n "$task_title" ]; then
  # Truncate to 20 chars for narrow screens
  if [ ${#task_title} -gt 20 ]; then
    task_title="${task_title:0:17}..."
  fi
  parts+=("$task_title")
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
  parts+=("${agent_count}ag")
fi

# Context usage
if [ -n "$ctx_pct" ]; then
  ctx_int=$(printf '%.0f' "$ctx_pct" 2>/dev/null || echo "$ctx_pct")
  parts+=("${ctx_int}%")
fi

# Cost
if [ -n "$cost" ]; then
  parts+=("\$${cost}")
fi

# Join with " | "
output=""
for i in "${!parts[@]}"; do
  if [ "$i" -gt 0 ]; then
    output+=" | "
  fi
  output+="${parts[$i]}"
done

echo "$output"
