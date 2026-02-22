#!/bin/bash
set -euo pipefail

PROMPT="${MOAT_AGENT_PROMPT:-}"
TOOLS="${MOAT_AGENT_TOOLS:-Read,Grep,Glob,Task,WebFetch,WebSearch}"
RUNTIME_BINARY="${MOAT_RUNTIME_BINARY:-claude}"

if [ -z "$PROMPT" ]; then
  echo "MOAT_AGENT_PROMPT not set" >&2
  exit 1
fi

case "$RUNTIME_BINARY" in
  claude)
    exec claude -p "$PROMPT" --allowedTools "$TOOLS"
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
