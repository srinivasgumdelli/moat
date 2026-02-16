#!/bin/bash
# Moat — thin shim that delegates to moat.mjs
# Resolves symlinks so node can find the repo directory.

resolve_path() {
  local path="$1"
  while [ -L "$path" ]; do
    local dir
    dir="$(cd -P "$(dirname "$path")" && pwd)"
    path="$(readlink "$path")"
    [[ "$path" != /* ]] && path="$dir/$path"
  done
  echo "$(cd -P "$(dirname "$path")" && pwd)/$(basename "$path")"
}

SCRIPT_PATH="$(resolve_path "${BASH_SOURCE[0]}")"
REPO_DIR="$(dirname "$SCRIPT_PATH")"

exec node "$REPO_DIR/moat.mjs" "$@"
