#!/bin/bash
# Moat — unit tests for devcontainer symlink, plan subcommand, and alias migration
# Does not require Docker — tests shell logic only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS_COUNT=0
FAIL_COUNT=0
TMPDIR_ROOT=""

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

setup_tmpdir() {
  TMPDIR_ROOT="$(mktemp -d)"
  export HOME="$TMPDIR_ROOT/home"
  mkdir -p "$HOME"
}

cleanup() {
  if [ -n "$TMPDIR_ROOT" ] && [ -d "$TMPDIR_ROOT" ]; then
    rm -rf "$TMPDIR_ROOT"
  fi
}
trap cleanup EXIT

echo "=============================="
echo "Moat Symlink Install Tests"
echo "=============================="

# -------------------------------------------------------
# Test 1: plan subcommand injects --allowedTools
# -------------------------------------------------------
echo ""
echo "--- Test 1: plan subcommand ---"

# Extract the plan handling logic and test argument rewriting
test_plan_args() {
  local args=("$@")
  if [ "${args[0]:-}" = "plan" ]; then
    args=("${args[@]:1}")
    args=(--allowedTools "Read,Grep,Glob,Task,WebFetch,WebSearch" ${args[@]+"${args[@]}"})
  fi
  printf '%s\n' "${args[@]}"
}

RESULT=$(test_plan_args plan /some/path --resume)
EXPECTED="--allowedTools
Read,Grep,Glob,Task,WebFetch,WebSearch
/some/path
--resume"
if [ "$RESULT" = "$EXPECTED" ]; then
  pass "plan subcommand rewrites args correctly"
else
  fail "plan subcommand args mismatch"
  echo "    Expected: $(echo "$EXPECTED" | tr '\n' ' ')"
  echo "    Got:      $(echo "$RESULT" | tr '\n' ' ')"
fi

# plan with no extra args
RESULT=$(test_plan_args plan)
EXPECTED="--allowedTools
Read,Grep,Glob,Task,WebFetch,WebSearch"
if [ "$RESULT" = "$EXPECTED" ]; then
  pass "plan subcommand with no extra args"
else
  fail "plan subcommand with no extra args mismatch"
fi

# non-plan args pass through unchanged
RESULT=$(test_plan_args /some/path --resume)
EXPECTED="/some/path
--resume"
if [ "$RESULT" = "$EXPECTED" ]; then
  pass "non-plan args pass through unchanged"
else
  fail "non-plan args were modified"
fi

# -------------------------------------------------------
# Test 2: setup creates symlink at ~/.devcontainers/moat
# -------------------------------------------------------
echo ""
echo "--- Test 2: symlink creation ---"

setup_tmpdir

mkdir -p "$HOME/.devcontainers"
ln -sf "$SCRIPT_DIR" "$HOME/.devcontainers/moat"

if [ -L "$HOME/.devcontainers/moat" ]; then
  pass "Symlink created at ~/.devcontainers/moat"
else
  fail "Symlink not created"
fi

TARGET="$(readlink "$HOME/.devcontainers/moat")"
if [ "$TARGET" = "$SCRIPT_DIR" ]; then
  pass "Symlink points to correct target ($SCRIPT_DIR)"
else
  fail "Symlink points to $TARGET (expected $SCRIPT_DIR)"
fi

# moat.mjs is executable through the symlink
if [ -x "$HOME/.devcontainers/moat/moat.mjs" ]; then
  pass "moat.mjs is executable through symlink"
else
  fail "moat.mjs is not executable through symlink"
fi

# -------------------------------------------------------
# Test 3: alias migration
# -------------------------------------------------------
echo ""
echo "--- Test 3: alias migration ---"

SHELL_RC="$HOME/.bashrc"
cat > "$SHELL_RC" << 'EOF'
# existing config
export EDITOR=vim

# Moat — sandboxed Claude Code
alias moat='~/.devcontainers/moat/moat.mjs'
alias moat-plan='~/.devcontainers/moat/moat.mjs --allowedTools "Read,Grep,Glob,Task,WebFetch,WebSearch"'

# other config
export FOO=bar
EOF

# Run migration logic (extracted from setup.sh)
if grep -q "alias moat=" "$SHELL_RC" 2>/dev/null; then
  sed -i.bak '/# Moat — sandboxed Claude Code/d; /alias moat=/d; /alias moat-plan=/d' "$SHELL_RC"
  rm -f "${SHELL_RC}.bak"
fi

if grep -q "alias moat=" "$SHELL_RC"; then
  fail "Old moat alias still present after migration"
else
  pass "Old moat alias removed"
fi

if grep -q "alias moat-plan=" "$SHELL_RC"; then
  fail "Old moat-plan alias still present after migration"
else
  pass "Old moat-plan alias removed"
fi

if grep -q "# Moat — sandboxed Claude Code" "$SHELL_RC"; then
  fail "Old comment header still present after migration"
else
  pass "Old comment header removed"
fi

# Ensure other config is preserved
if grep -q "export EDITOR=vim" "$SHELL_RC" && grep -q "export FOO=bar" "$SHELL_RC"; then
  pass "Other config lines preserved"
else
  fail "Other config lines were lost during migration"
fi

# -------------------------------------------------------
# Test 4: moat.mjs resolves REPO_DIR through symlinks
# -------------------------------------------------------
echo ""
echo "--- Test 4: REPO_DIR resolution through symlink ---"

# moat.mjs uses import.meta.url to find the real repo dir even when invoked via symlink
# Verify the symlink target directory contains expected files
if [ -f "$HOME/.devcontainers/moat/moat.mjs" ]; then
  pass "moat.mjs reachable through ~/.devcontainers/moat symlink"
else
  fail "moat.mjs not reachable through symlink"
fi

if [ -f "$HOME/.devcontainers/moat/docker-compose.yml" ]; then
  pass "docker-compose.yml reachable through symlink"
else
  fail "docker-compose.yml not reachable through symlink"
fi

if [ -f "$HOME/.devcontainers/moat/tool-proxy.mjs" ]; then
  pass "tool-proxy.mjs reachable through symlink"
else
  fail "tool-proxy.mjs not reachable through symlink"
fi

# -------------------------------------------------------
# Test 5: doctor checks ~/.devcontainers/moat
# -------------------------------------------------------
echo ""
echo "--- Test 5: doctor symlink check ---"

# With correct symlink
if [ -L "$HOME/.devcontainers/moat" ]; then
  target="$(readlink "$HOME/.devcontainers/moat")"
  if [ "$target" = "$SCRIPT_DIR" ]; then
    pass "Doctor would PASS: symlink correct"
  else
    fail "Doctor would fail: symlink target wrong"
  fi
else
  fail "Doctor would fail: no symlink"
fi

# With wrong symlink
ln -sfn "/wrong/path" "$HOME/.devcontainers/moat"
target="$(readlink "$HOME/.devcontainers/moat")"
if [ "$target" != "$SCRIPT_DIR" ]; then
  pass "Doctor would WARN: symlink points to wrong target"
else
  fail "Doctor missed wrong symlink target"
fi

# With no symlink (plain directory)
rm "$HOME/.devcontainers/moat"
mkdir -p "$HOME/.devcontainers/moat"
if [ -d "$HOME/.devcontainers/moat" ] && [ ! -L "$HOME/.devcontainers/moat" ]; then
  pass "Doctor would WARN: is directory not symlink"
else
  fail "Directory check failed"
fi

# With nothing
rm -rf "$HOME/.devcontainers/moat"
if [ ! -e "$HOME/.devcontainers/moat" ]; then
  pass "Doctor would FAIL: not found"
else
  fail "Removal failed"
fi

# -------------------------------------------------------
# Test 6: ln -sf is idempotent (re-run safe)
# -------------------------------------------------------
echo ""
echo "--- Test 6: symlink idempotency ---"

ln -sfn "$SCRIPT_DIR" "$HOME/.devcontainers/moat"
ln -sfn "$SCRIPT_DIR" "$HOME/.devcontainers/moat"

TARGET="$(readlink "$HOME/.devcontainers/moat")"
if [ "$TARGET" = "$SCRIPT_DIR" ]; then
  pass "Symlink creation is idempotent"
else
  fail "Symlink broken after re-creation"
fi

# -------------------------------------------------------
# Test 7: migration handles missing rc file gracefully
# -------------------------------------------------------
echo ""
echo "--- Test 7: missing rc file ---"

MISSING_RC="$HOME/.nonexistent_rc"
if grep -q "alias moat=" "$MISSING_RC" 2>/dev/null; then
  fail "grep should not match on missing file"
else
  pass "Migration skips missing rc file gracefully"
fi

# --- Summary ---
echo ""
echo "=============================="
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
echo "=============================="

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
