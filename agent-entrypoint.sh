#!/bin/bash
set -euo pipefail

PROMPT="${MOAT_AGENT_PROMPT:-}"
TOOLS="${MOAT_AGENT_TOOLS:-Read,Grep,Glob,Task,WebFetch,WebSearch}"

if [ -z "$PROMPT" ]; then
  echo "MOAT_AGENT_PROMPT not set" >&2
  exit 1
fi

exec claude -p "$PROMPT" --allowedTools "$TOOLS"
