#!/bin/bash
# PostToolUse hook: run fast linters after Edit/Write
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ] && exit 0

DIAG=""
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx)
    if [ -x "node_modules/.bin/eslint" ]; then
      DIAG=$(node_modules/.bin/eslint --no-color --format compact "$FILE_PATH" 2>&1 || true)
    fi
    ;;
  *.py)
    DIAG=$(ruff check --output-format text "$FILE_PATH" 2>&1 || true)
    ;;
  *.go)
    DIAG=$(cd "$(dirname "$FILE_PATH")" && go vet ./... 2>&1 || true)
    ;;
esac

# Only inject context if there are diagnostics
if [ -n "$DIAG" ] && [ "$DIAG" != "" ]; then
  jq -n --arg ctx "$DIAG" '{
    "hookSpecificOutput": {
      "hookEventName": "PostToolUse",
      "additionalContext": ("Lint diagnostics:\n" + $ctx)
    }
  }'
fi
exit 0
