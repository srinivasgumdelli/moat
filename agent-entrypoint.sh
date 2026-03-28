#!/bin/bash
set -euo pipefail

PROMPT="${MOAT_AGENT_PROMPT:-}"
TOOLS="${MOAT_AGENT_TOOLS:-Read,Grep,Glob,Task,WebFetch,WebSearch}"
RUNTIME_BINARY="${MOAT_RUNTIME_BINARY:-claude}"
MODEL="${MOAT_AGENT_MODEL:-}"

if [ -z "$PROMPT" ]; then
  echo "MOAT_AGENT_PROMPT not set" >&2
  exit 1
fi

case "$RUNTIME_BINARY" in
  claude)
    if [ -n "$MODEL" ]; then
      exec claude -p "$PROMPT" --allowedTools "$TOOLS" --model "$MODEL"
    else
      exec claude -p "$PROMPT" --allowedTools "$TOOLS"
    fi
    ;;
  codex)
    exec codex --full-auto "$PROMPT"
    ;;
  opencode)
    exec opencode "$PROMPT"
    ;;
  amp)
    exec amp --yes "$PROMPT"
    ;;
  *)
    echo "Unknown runtime binary: $RUNTIME_BINARY" >&2
    exit 1
    ;;
esac
