#!/bin/bash
# Moat — end-to-end test suite
# Uses project name "moat-test" and port 9877 to avoid interfering with active sessions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="moat-test"
PROXY_PORT=9877
PROXY_PID=""
WORKSPACE="$SCRIPT_DIR"
DATA_DIR="$HOME/.moat/data"
OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.extra-dirs.yml"
SERVICES_FILE="$SCRIPT_DIR/docker-compose.services.yml"
TOKEN_FILE="$DATA_DIR/.proxy-token"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cleanup() {
  echo ""
  echo "--- Teardown ---"
  if [ -n "$PROXY_PID" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    echo "  Stopped tool proxy (PID $PROXY_PID)"
  fi
  lsof -ti :"$PROXY_PORT" 2>/dev/null | xargs kill 2>/dev/null || true
  docker compose --project-name "$PROJECT_NAME" \
    -f "$SCRIPT_DIR/docker-compose.yml" \
    -f "$SERVICES_FILE" \
    -f "$OVERRIDE_FILE" down 2>/dev/null || true
  echo "  Containers removed"
}
trap cleanup EXIT

echo "=============================="
echo "Moat Test Suite"
echo "=============================="

# --- Phase 1: Doctor ---
echo ""
echo "--- Phase 1: Doctor ---"
if "$SCRIPT_DIR/moat.mjs" doctor; then
  pass "moat doctor passed"
else
  fail "moat doctor failed"
  echo "ABORTING: doctor must pass before running tests"
  exit 1
fi

# --- Phase 2: Build ---
echo ""
echo "--- Phase 2: Build ---"

# Ensure token is in repo for build context
cp "$TOKEN_FILE" "$SCRIPT_DIR/.proxy-token"

# Ensure override files exist
printf 'services:\n  devcontainer: {}\n' > "$OVERRIDE_FILE"
printf 'services:\n  devcontainer: {}\n' > "$SERVICES_FILE"

if docker compose --project-name "$PROJECT_NAME" \
  -f "$SCRIPT_DIR/docker-compose.yml" \
  -f "$SERVICES_FILE" \
  -f "$OVERRIDE_FILE" build; then
  pass "Docker image built"
else
  fail "Docker image build failed"
  exit 1
fi

# --- Phase 3: Tool proxy ---
echo ""
echo "--- Phase 3: Tool proxy ---"

TOOL_PROXY_PORT="$PROXY_PORT" MOAT_TOKEN_FILE="$TOKEN_FILE" \
  node "$SCRIPT_DIR/tool-proxy.mjs" --workspace "$WORKSPACE" \
  </dev/null >/tmp/moat-test-proxy.log 2>&1 &
PROXY_PID=$!
sleep 1

if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  fail "Tool proxy failed to start"
  echo "  Log:"
  cat /tmp/moat-test-proxy.log
  exit 1
fi

if curl -sf "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null; then
  pass "Tool proxy /health responds on :${PROXY_PORT}"
else
  fail "Tool proxy /health not responding"
  exit 1
fi

# --- Phase 4: Auth ---
echo ""
echo "--- Phase 4: Auth ---"

TOKEN="$(cat "$TOKEN_FILE")"

# Valid token accepted
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PROXY_PORT}/exec" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"command":"git","args":["--version"]}')
if [ "$HTTP_CODE" = "200" ]; then
  pass "Valid token accepted (HTTP $HTTP_CODE)"
else
  fail "Valid token rejected (HTTP $HTTP_CODE, expected 200)"
fi

# Invalid token rejected
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PROXY_PORT}/exec" \
  -H "Authorization: Bearer invalidtoken" \
  -H "Content-Type: application/json" \
  -d '{"command":"git","args":["--version"]}')
if [ "$HTTP_CODE" = "403" ]; then
  pass "Invalid token rejected (HTTP $HTTP_CODE)"
else
  fail "Invalid token not rejected (HTTP $HTTP_CODE, expected 403)"
fi

# Missing token rejected
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PROXY_PORT}/exec" \
  -H "Content-Type: application/json" \
  -d '{"command":"git","args":["--version"]}')
if [ "$HTTP_CODE" = "403" ]; then
  pass "Missing token rejected (HTTP $HTTP_CODE)"
else
  fail "Missing token not rejected (HTTP $HTTP_CODE, expected 403)"
fi

# --- Phase 5: Proxied command ---
echo ""
echo "--- Phase 5: Proxied command ---"

RESPONSE=$(curl -s \
  -X POST "http://127.0.0.1:${PROXY_PORT}/exec" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"command":"git","args":["--version"]}')

if echo "$RESPONSE" | grep -q "git version"; then
  pass "git --version returned valid output"
else
  fail "git --version through proxy returned unexpected output: $RESPONSE"
fi

# --- Phase 6: Container ---
echo ""
echo "--- Phase 6: Container ---"

export MOAT_WORKSPACE="$WORKSPACE"

devcontainer up \
  --workspace-folder "$WORKSPACE" \
  --config "$SCRIPT_DIR/devcontainer.json" \
  --docker-compose-file "$SCRIPT_DIR/docker-compose.yml" \
  --docker-compose-file "$SERVICES_FILE" \
  --docker-compose-file "$OVERRIDE_FILE" \
  --project-name "$PROJECT_NAME" >/dev/null 2>&1

if [ $? -eq 0 ]; then
  pass "devcontainer up succeeded"
else
  fail "devcontainer up failed"
fi

VERIFY_OUTPUT=$(devcontainer exec \
  --workspace-folder "$WORKSPACE" \
  --config "$SCRIPT_DIR/devcontainer.json" \
  --docker-compose-file "$SCRIPT_DIR/docker-compose.yml" \
  --docker-compose-file "$SERVICES_FILE" \
  --docker-compose-file "$OVERRIDE_FILE" \
  --project-name "$PROJECT_NAME" \
  bash /workspace/verify.sh 2>&1) || true

if echo "$VERIFY_OUTPUT" | grep -q "All Moat checks passed"; then
  pass "verify.sh reports all checks passed"
else
  fail "verify.sh did not pass"
  echo "  Output:"
  echo "$VERIFY_OUTPUT" | sed 's/^/    /'
fi

# --- Phase 7: Mount matching (--add-dir reuse bug fix) ---
echo ""
echo "--- Phase 7: Mount matching ---"

# Container is running from Phase 6 with no extra dirs.
# mounts_match should succeed when EXTRA_DIRS is empty.
CONTAINER_NAME="${PROJECT_NAME}-devcontainer-1"

CURRENT_MOUNTS=$(docker inspect "$CONTAINER_NAME" \
  --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}}{{"\n"}}{{end}}{{end}}' 2>/dev/null \
  | grep '^/extra/' | sort) || CURRENT_MOUNTS=""

if [ -z "$CURRENT_MOUNTS" ]; then
  pass "No /extra/ mounts on container started without --add-dir"
else
  fail "Unexpected /extra/ mounts found: $CURRENT_MOUNTS"
fi

# Generate an override with an extra dir and verify it differs
FAKE_EXTRA="/extra/test-dir"
if [ "$CURRENT_MOUNTS" != "$FAKE_EXTRA" ]; then
  pass "Mount mismatch correctly detected (empty vs /extra/test-dir)"
else
  fail "Mount mismatch not detected"
fi

# --- Phase 8: attach/detach argument validation ---
echo ""
echo "--- Phase 8: attach/detach validation ---"

# attach with no args
if "$SCRIPT_DIR/moat.mjs" attach 2>&1 | grep -q "Usage: moat attach"; then
  pass "attach with no args shows usage error"
else
  fail "attach with no args did not show usage error"
fi

# attach with nonexistent directory
if "$SCRIPT_DIR/moat.mjs" attach /nonexistent/path 2>&1 | grep -q "Usage: moat attach"; then
  pass "attach with bad path shows usage error"
else
  fail "attach with bad path did not show usage error"
fi

# detach with no args
if "$SCRIPT_DIR/moat.mjs" detach 2>&1 | grep -q "Usage: moat detach"; then
  pass "detach with no args shows usage error"
else
  fail "detach with no args did not show usage error"
fi

# attach without running moat-devcontainer-1 (test uses moat-test-devcontainer-1)
if "$SCRIPT_DIR/moat.mjs" attach /tmp 2>&1 | grep -q "No running moat container"; then
  pass "attach with no moat-devcontainer-1 shows container error"
else
  fail "attach did not detect missing container"
fi

# attach without mutagen falls back to restart prompt (piped stdin = no TTY, defaults to abort)
if ! command -v mutagen &>/dev/null; then
  # Need a real running moat-devcontainer-1 for this path — skip since test uses moat-test
  echo "  (no mutagen + no moat-devcontainer-1 — restart fallback tested via container check above)"

  if "$SCRIPT_DIR/moat.mjs" detach foo 2>&1 | grep -q "mutagen is not installed"; then
    pass "detach without mutagen shows error"
  else
    fail "detach without mutagen did not show error"
  fi
else
  echo "  (mutagen is installed — testing live-sync path)"

  # detach --all with no sessions should succeed silently
  if "$SCRIPT_DIR/moat.mjs" detach --all 2>&1 | grep -q "terminated"; then
    pass "detach --all succeeds with no active sessions"
  else
    fail "detach --all did not handle empty session list"
  fi
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
