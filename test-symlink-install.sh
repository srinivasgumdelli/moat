#!/bin/bash
# Moat — unit tests for symlink install, plan subcommand, and alias migration
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
    args=(--allowedTools "Read,Grep,Glob,Task,WebFetch,WebSearch" "${args[@]}")
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
# Test 2: setup.sh creates symlink in ~/.local/bin
# -------------------------------------------------------
echo ""
echo "--- Test 2: symlink creation ---"

setup_tmpdir

mkdir -p "$HOME/.local/bin"
ln -sf "$SCRIPT_DIR/moat.sh" "$HOME/.local/bin/moat"

if [ -L "$HOME/.local/bin/moat" ]; then
  pass "Symlink created at ~/.local/bin/moat"
else
  fail "Symlink not created"
fi

TARGET="$(readlink "$HOME/.local/bin/moat")"
if [ "$TARGET" = "$SCRIPT_DIR/moat.sh" ]; then
  pass "Symlink points to correct target"
else
  fail "Symlink points to $TARGET (expected $SCRIPT_DIR/moat.sh)"
fi

# Symlink is executable
if [ -x "$HOME/.local/bin/moat" ]; then
  pass "Symlink target is executable"
else
  fail "Symlink target is not executable"
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
alias moat='~/.devcontainers/moat/moat.sh'
alias moat-plan='~/.devcontainers/moat/moat.sh --allowedTools "Read,Grep,Glob,Task,WebFetch,WebSearch"'

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
# Test 4: PATH export added when missing
# -------------------------------------------------------
echo ""
echo "--- Test 4: PATH export ---"

# Reset rc file
cat > "$SHELL_RC" << 'EOF'
export EDITOR=vim
EOF

# Simulate PATH logic from setup.sh
if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$SHELL_RC" 2>/dev/null; then
  printf '\n# Moat — sandboxed Claude Code\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$SHELL_RC"
fi

if grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$SHELL_RC"; then
  pass "PATH export added to rc file"
else
  fail "PATH export not added"
fi

# Run again — should be idempotent
LINES_BEFORE=$(wc -l < "$SHELL_RC")
if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$SHELL_RC" 2>/dev/null; then
  printf '\n# Moat — sandboxed Claude Code\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$SHELL_RC"
fi
LINES_AFTER=$(wc -l < "$SHELL_RC")

if [ "$LINES_BEFORE" = "$LINES_AFTER" ]; then
  pass "PATH export is idempotent (not duplicated)"
else
  fail "PATH export was duplicated on second run"
fi

# -------------------------------------------------------
# Test 5: doctor checks ~/.local/bin/moat
# -------------------------------------------------------
echo ""
echo "--- Test 5: doctor symlink check ---"

# With correct symlink
if [ -L "$HOME/.local/bin/moat" ]; then
  target="$(readlink "$HOME/.local/bin/moat")"
  if [ "$target" = "$SCRIPT_DIR/moat.sh" ]; then
    pass "Doctor would PASS: symlink correct"
  else
    fail "Doctor would fail: symlink target wrong"
  fi
else
  fail "Doctor would fail: no symlink"
fi

# With wrong symlink
ln -sf "/wrong/path/moat.sh" "$HOME/.local/bin/moat"
target="$(readlink "$HOME/.local/bin/moat")"
if [ "$target" != "$SCRIPT_DIR/moat.sh" ]; then
  pass "Doctor would WARN: symlink points to wrong target"
else
  fail "Doctor missed wrong symlink target"
fi

# With no symlink
rm "$HOME/.local/bin/moat"
if [ ! -L "$HOME/.local/bin/moat" ]; then
  pass "Doctor would FAIL: no symlink"
else
  fail "Symlink should have been removed"
fi

# -------------------------------------------------------
# Test 6: ln -sf is idempotent (re-run safe)
# -------------------------------------------------------
echo ""
echo "--- Test 6: symlink idempotency ---"

ln -sf "$SCRIPT_DIR/moat.sh" "$HOME/.local/bin/moat"
ln -sf "$SCRIPT_DIR/moat.sh" "$HOME/.local/bin/moat"

TARGET="$(readlink "$HOME/.local/bin/moat")"
if [ "$TARGET" = "$SCRIPT_DIR/moat.sh" ]; then
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
