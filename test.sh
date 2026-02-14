#!/bin/bash
# Moat — end-to-end test suite
# Uses project name "moat-test" and port 9877 to avoid interfering with active sessions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="moat-test"
PROXY_PORT=9877
PROXY_PID=""
WORKSPACE="$SCRIPT_DIR"
DATA_DIR="$HOME/.local/share/moat-data"
OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.extra-dirs.yml"
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
if "$SCRIPT_DIR/moat.sh" doctor; then
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

# Ensure override file exists
printf 'services:\n  devcontainer: {}\n' > "$OVERRIDE_FILE"

if docker compose --project-name "$PROJECT_NAME" \
  -f "$SCRIPT_DIR/docker-compose.yml" \
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

# --- Summary ---
echo ""
echo "=============================="
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
echo "=============================="

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
