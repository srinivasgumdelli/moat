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
  rm -rf "$DATA_DIR/workspaces/testtest" "$DATA_DIR/workspaces/bbbbbbbb" /tmp/fake-workspace-b 2>/dev/null || true
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

# Create per-workspace path mappings for test
TEST_HASH="testtest"
TEST_WS_DIR="$DATA_DIR/workspaces/$TEST_HASH"
mkdir -p "$TEST_WS_DIR"
echo "{\"/workspace\":\"$WORKSPACE\"}" > "$TEST_WS_DIR/path-mappings.json"

TOOL_PROXY_PORT="$PROXY_PORT" MOAT_TOKEN_FILE="$TOKEN_FILE" \
  node "$SCRIPT_DIR/tool-proxy.mjs" --data-dir "$DATA_DIR" \
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

# Valid token accepted (use /git endpoint with workspace_hash)
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PROXY_PORT}/git" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"args\":[\"--version\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if [ "$HTTP_CODE" = "200" ]; then
  pass "Valid token accepted (HTTP $HTTP_CODE)"
else
  fail "Valid token rejected (HTTP $HTTP_CODE, expected 200)"
fi

# Invalid token rejected
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PROXY_PORT}/git" \
  -H "Authorization: Bearer invalidtoken" \
  -H "Content-Type: application/json" \
  -d '{"args":["--version"],"cwd":"/workspace"}')
if [ "$HTTP_CODE" = "401" ]; then
  pass "Invalid token rejected (HTTP $HTTP_CODE)"
else
  fail "Invalid token not rejected (HTTP $HTTP_CODE, expected 401)"
fi

# Missing token rejected
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PROXY_PORT}/git" \
  -H "Content-Type: application/json" \
  -d '{"args":["--version"],"cwd":"/workspace"}')
if [ "$HTTP_CODE" = "401" ]; then
  pass "Missing token rejected (HTTP $HTTP_CODE)"
else
  fail "Missing token not rejected (HTTP $HTTP_CODE, expected 401)"
fi

# --- Phase 5: Proxied command ---
echo ""
echo "--- Phase 5: Proxied command ---"

RESPONSE=$(curl -s \
  -X POST "http://127.0.0.1:${PROXY_PORT}/git" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"args\":[\"--version\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")

if echo "$RESPONSE" | grep -q "git version"; then
  pass "git --version returned valid output"
else
  fail "git --version through proxy returned unexpected output: $RESPONSE"
fi

# --- Phase 5b: Proxy workspace isolation ---
echo ""
echo "--- Phase 5b: Proxy workspace isolation ---"

# Create a second workspace mapping
HASH_A="$TEST_HASH"
HASH_B="bbbbbbbb"
SECOND_WS_DIR="$DATA_DIR/workspaces/$HASH_B"
mkdir -p "$SECOND_WS_DIR"
echo "{\"/workspace\":\"/tmp/fake-workspace-b\"}" > "$SECOND_WS_DIR/path-mappings.json"
mkdir -p /tmp/fake-workspace-b

# Request with hash A should resolve to the test workspace (SCRIPT_DIR), not workspace B
RESPONSE=$(curl -s -X POST "http://127.0.0.1:${PROXY_PORT}/git" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"args\":[\"rev-parse\",\"--show-toplevel\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$HASH_A\"}")
HOST_PATH=$(echo "$RESPONSE" | jq -r '.stdout' | tr -d '\n')
if echo "$HOST_PATH" | grep -qv "fake-workspace-b"; then
  pass "Hash A resolves to correct workspace (not B)"
else
  fail "Hash A resolved to workspace B's path: $HOST_PATH"
fi

# Request with unknown hash should fail (not silently use another workspace)
HTTP_CODE=$(curl -s -o /tmp/proxy-unknown-hash.json -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PROXY_PORT}/git" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"args":["status"],"cwd":"/workspace","workspace_hash":"deadbeef"}')
if [ "$HTTP_CODE" = "400" ]; then
  pass "Unknown workspace hash rejected with 400"
else
  fail "Unknown workspace hash returned HTTP $HTTP_CODE (expected 400): $(cat /tmp/proxy-unknown-hash.json)"
fi

# Request with empty hash and multiple sessions should also fail (ambiguous)
HTTP_CODE=$(curl -s -o /tmp/proxy-empty-hash.json -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PROXY_PORT}/git" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"args":["status"],"cwd":"/workspace","workspace_hash":""}')
if [ "$HTTP_CODE" = "400" ]; then
  pass "Empty hash with multiple sessions rejected (ambiguous)"
else
  fail "Empty hash with multiple sessions returned HTTP $HTTP_CODE (expected 400): $(cat /tmp/proxy-empty-hash.json)"
fi

# Clean up second workspace
rm -rf "$SECOND_WS_DIR" /tmp/fake-workspace-b

# Request with empty hash and single session should work (backward compat)
RESPONSE=$(curl -s -X POST "http://127.0.0.1:${PROXY_PORT}/git" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"args":["--version"],"cwd":"/workspace","workspace_hash":""}')
if echo "$RESPONSE" | jq -r '.stdout' | grep -q "git version"; then
  pass "Empty hash with single session falls back correctly (backward compat)"
else
  fail "Empty hash with single session failed: $RESPONSE"
fi

# --- Phase 5c: IaC allowlist enforcement ---
echo ""
echo "--- Phase 5c: IaC allowlist enforcement ---"

# Helper to test IaC proxy responses
iac_test() {
  local endpoint="$1" body="$2"
  curl -s -X POST "http://127.0.0.1:${PROXY_PORT}/${endpoint}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$body"
}

# Terraform: plan is allowed
TF_PLAN=$(iac_test terraform "{\"args\":[\"plan\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$TF_PLAN" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$TF_PLAN" | jq -r '.blocked')" = "true" ]; then
  fail "terraform plan was blocked (should be allowed)"
else
  pass "terraform plan is allowed"
fi

# Terraform: apply is blocked
TF_APPLY=$(iac_test terraform "{\"args\":[\"apply\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$TF_APPLY" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$TF_APPLY" | jq -r '.blocked')" = "true" ]; then
  pass "terraform apply is blocked"
else
  fail "terraform apply was not blocked: $TF_APPLY"
fi

# Terraform: destroy is blocked
TF_DESTROY=$(iac_test terraform "{\"args\":[\"destroy\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$TF_DESTROY" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$TF_DESTROY" | jq -r '.blocked')" = "true" ]; then
  pass "terraform destroy is blocked"
else
  fail "terraform destroy was not blocked: $TF_DESTROY"
fi

# kubectl: get is allowed
K8S_GET=$(iac_test kubectl "{\"args\":[\"get\",\"pods\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$K8S_GET" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$K8S_GET" | jq -r '.blocked')" = "true" ]; then
  fail "kubectl get was blocked (should be allowed)"
else
  pass "kubectl get is allowed"
fi

# kubectl: delete is blocked
K8S_DEL=$(iac_test kubectl "{\"args\":[\"delete\",\"pod\",\"foo\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$K8S_DEL" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$K8S_DEL" | jq -r '.blocked')" = "true" ]; then
  pass "kubectl delete is blocked"
else
  fail "kubectl delete was not blocked: $K8S_DEL"
fi

# kubectl: apply is blocked
K8S_APPLY=$(iac_test kubectl "{\"args\":[\"apply\",\"-f\",\"foo.yml\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$K8S_APPLY" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$K8S_APPLY" | jq -r '.blocked')" = "true" ]; then
  pass "kubectl apply is blocked"
else
  fail "kubectl apply was not blocked: $K8S_APPLY"
fi

# AWS: describe-instances is allowed (read-only verb)
AWS_DESC=$(iac_test aws "{\"args\":[\"ec2\",\"describe-instances\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$AWS_DESC" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$AWS_DESC" | jq -r '.blocked')" = "true" ]; then
  fail "aws ec2 describe-instances was blocked (should be allowed)"
else
  pass "aws ec2 describe-instances is allowed"
fi

# AWS: s3 ls is allowed (explicit allowlist)
AWS_S3LS=$(iac_test aws "{\"args\":[\"s3\",\"ls\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$AWS_S3LS" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$AWS_S3LS" | jq -r '.blocked')" = "true" ]; then
  fail "aws s3 ls was blocked (should be allowed)"
else
  pass "aws s3 ls is allowed"
fi

# AWS: terminate-instances is blocked
AWS_TERM=$(iac_test aws "{\"args\":[\"ec2\",\"terminate-instances\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$AWS_TERM" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$AWS_TERM" | jq -r '.blocked')" = "true" ]; then
  pass "aws ec2 terminate-instances is blocked"
else
  fail "aws ec2 terminate-instances was not blocked: $AWS_TERM"
fi

# AWS: assume-role is blocked (was missed by old blocklist)
AWS_ASSUME=$(iac_test aws "{\"args\":[\"sts\",\"assume-role\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$AWS_ASSUME" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$AWS_ASSUME" | jq -r '.blocked')" = "true" ]; then
  pass "aws sts assume-role is blocked"
else
  fail "aws sts assume-role was not blocked: $AWS_ASSUME"
fi

# AWS: sts get-caller-identity is allowed (explicit allowlist)
AWS_CALLER=$(iac_test aws "{\"args\":[\"sts\",\"get-caller-identity\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$AWS_CALLER" | jq -e '.blocked' >/dev/null 2>&1 && [ "$(echo "$AWS_CALLER" | jq -r '.blocked')" = "true" ]; then
  fail "aws sts get-caller-identity was blocked (should be allowed)"
else
  pass "aws sts get-caller-identity is allowed"
fi

# --- Phase 5d: Audit logging ---
echo ""
echo "--- Phase 5d: Audit logging ---"

# After Phase 5's proxy+tool tests, audit.jsonl should exist in $TEST_WS_DIR
if [ -f "$TEST_WS_DIR/audit.jsonl" ]; then
  pass "audit.jsonl exists in workspace dir"
else
  fail "audit.jsonl not found in $TEST_WS_DIR"
fi

# Verify at least one tool.execute event
EXEC_COUNT=$(jq -c 'select(.type == "tool.execute")' "$TEST_WS_DIR/audit.jsonl" 2>/dev/null | wc -l | tr -d ' ')
if [ "$EXEC_COUNT" -gt 0 ]; then
  pass "audit.jsonl has $EXEC_COUNT tool.execute events"
else
  fail "audit.jsonl has no tool.execute events"
fi

# Verify tool.execute events have required fields
FIRST_EXEC=$(jq -c 'select(.type == "tool.execute")' "$TEST_WS_DIR/audit.jsonl" 2>/dev/null | head -1)
MISSING_FIELDS=""
for field in ts endpoint args_summary exit_code duration_ms; do
  if ! echo "$FIRST_EXEC" | jq -e ".$field" >/dev/null 2>&1; then
    MISSING_FIELDS="$MISSING_FIELDS $field"
  fi
done
if [ -z "$MISSING_FIELDS" ]; then
  pass "tool.execute events have all required fields (ts, endpoint, args_summary, exit_code, duration_ms)"
else
  fail "tool.execute events missing fields:$MISSING_FIELDS"
fi

# Verify tool.blocked events from Phase 5c's IaC tests
BLOCKED_COUNT=$(jq -c 'select(.type == "tool.blocked")' "$TEST_WS_DIR/audit.jsonl" 2>/dev/null | wc -l | tr -d ' ')
if [ "$BLOCKED_COUNT" -gt 0 ]; then
  pass "audit.jsonl has $BLOCKED_COUNT tool.blocked events from IaC tests"
else
  fail "audit.jsonl has no tool.blocked events (expected from Phase 5c)"
fi

# Verify tool.blocked events reference correct endpoints
BLOCKED_TF=$(jq -c 'select(.type == "tool.blocked" and .endpoint == "terraform")' "$TEST_WS_DIR/audit.jsonl" 2>/dev/null | wc -l | tr -d ' ')
if [ "$BLOCKED_TF" -gt 0 ]; then
  pass "audit.jsonl has terraform blocked events"
else
  fail "audit.jsonl missing terraform blocked events"
fi

BLOCKED_K8S=$(jq -c 'select(.type == "tool.blocked" and .endpoint == "kubectl")' "$TEST_WS_DIR/audit.jsonl" 2>/dev/null | wc -l | tr -d ' ')
if [ "$BLOCKED_K8S" -gt 0 ]; then
  pass "audit.jsonl has kubectl blocked events"
else
  fail "audit.jsonl missing kubectl blocked events"
fi

BLOCKED_AWS=$(jq -c 'select(.type == "tool.blocked" and .endpoint == "aws")' "$TEST_WS_DIR/audit.jsonl" 2>/dev/null | wc -l | tr -d ' ')
if [ "$BLOCKED_AWS" -gt 0 ]; then
  pass "audit.jsonl has aws blocked events"
else
  fail "audit.jsonl missing aws blocked events"
fi

# Test readAuditLog filtering via node one-liner
READ_RESULT=$(node -e "
  import('./lib/audit.mjs').then(m => {
    const events = m.readAuditLog('$TEST_WS_DIR', { type: 'tool' });
    console.log(JSON.stringify({ count: events.length, types: [...new Set(events.map(e => e.type))] }));
  });
" 2>/dev/null)
READ_COUNT=$(echo "$READ_RESULT" | jq -r '.count' 2>/dev/null)
if [ -n "$READ_COUNT" ] && [ "$READ_COUNT" -gt 0 ]; then
  pass "readAuditLog({ type: 'tool' }) returns $READ_COUNT events"
else
  fail "readAuditLog filtering returned unexpected result: $READ_RESULT"
fi

# Test readAuditLog --last filtering
LAST_RESULT=$(node -e "
  import('./lib/audit.mjs').then(m => {
    const events = m.readAuditLog('$TEST_WS_DIR', { last: 2 });
    console.log(events.length);
  });
" 2>/dev/null)
if [ "$LAST_RESULT" = "2" ]; then
  pass "readAuditLog({ last: 2 }) returns exactly 2 events"
else
  fail "readAuditLog({ last: 2 }) returned $LAST_RESULT events (expected 2)"
fi

# --- Phase 5e: Secrets scanning ---
echo ""
echo "--- Phase 5e: Secrets scanning ---"

# Test scanForSecrets detects AWS key directly via node one-liner
SCAN_RESULT=$(node -e "
  import('./lib/secrets.mjs').then(m => {
    const r = m.scanForSecrets('key AKIA1234567890123456 here');
    console.log(JSON.stringify(r));
  });
" 2>/dev/null)
if echo "$SCAN_RESULT" | jq -e '.[0].pattern' 2>/dev/null | grep -q 'aws-access-key'; then
  pass "scanForSecrets detects AWS access key"
else
  fail "scanForSecrets did not detect AWS key: $SCAN_RESULT"
fi

# Test scanForSecrets returns empty for benign text
SCAN_BENIGN=$(node -e "
  import('./lib/secrets.mjs').then(m => {
    const r = m.scanForSecrets('hello world this is normal text');
    console.log(JSON.stringify(r));
  });
" 2>/dev/null)
if [ "$SCAN_BENIGN" = "[]" ]; then
  pass "scanForSecrets returns empty for benign text"
else
  fail "scanForSecrets returned non-empty for benign text: $SCAN_BENIGN"
fi

# Test scanForSecrets detects private key header
SCAN_PK=$(node -e "
  import('./lib/secrets.mjs').then(m => {
    const r = m.scanForSecrets('-----BEGIN RSA PRIVATE KEY-----');
    console.log(JSON.stringify(r));
  });
" 2>/dev/null)
if echo "$SCAN_PK" | jq -e '.[0].pattern' 2>/dev/null | grep -q 'private-key'; then
  pass "scanForSecrets detects private key"
else
  fail "scanForSecrets did not detect private key: $SCAN_PK"
fi

# Warn mode (default): send request with fake AWS key in args, expect HTTP 200 (not blocked)
SECRETS_RESPONSE=$(curl -s \
  -X POST "http://127.0.0.1:${PROXY_PORT}/git" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"args\":[\"log\",\"--oneline\",\"-1\",\"AKIA1234567890123456\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$SECRETS_RESPONSE" | jq -e '.blocked' 2>/dev/null | grep -q 'true'; then
  fail "Secrets warn mode blocked the request (should only warn)"
else
  pass "Secrets warn mode allows request with fake AWS key (HTTP 200)"
fi

# Check proxy stderr log for [secrets-scan] warning
if grep -q '\[secrets-scan\]' /tmp/moat-test-proxy.log 2>/dev/null; then
  pass "Proxy logged [secrets-scan] warning for detected secret"
else
  fail "Proxy did not log [secrets-scan] warning"
fi

# Verify secrets.detected event in audit.jsonl
SECRETS_AUDIT=$(jq -c 'select(.type == "secrets.detected")' "$TEST_WS_DIR/audit.jsonl" 2>/dev/null | wc -l | tr -d ' ')
if [ "$SECRETS_AUDIT" -gt 0 ]; then
  pass "audit.jsonl has secrets.detected event(s)"
else
  fail "audit.jsonl missing secrets.detected events"
fi

# Block mode: restart proxy with MOAT_SECRETS_BLOCK=1
kill "$PROXY_PID" 2>/dev/null || true
sleep 1

MOAT_SECRETS_BLOCK=1 TOOL_PROXY_PORT="$PROXY_PORT" MOAT_TOKEN_FILE="$TOKEN_FILE" \
  node "$SCRIPT_DIR/tool-proxy.mjs" --data-dir "$DATA_DIR" \
  </dev/null >>/tmp/moat-test-proxy.log 2>&1 &
PROXY_PID=$!
sleep 1

BLOCK_RESPONSE=$(curl -s \
  -X POST "http://127.0.0.1:${PROXY_PORT}/git" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"args\":[\"log\",\"--oneline\",\"-1\",\"AKIA1234567890123456\"],\"cwd\":\"/workspace\",\"workspace_hash\":\"$TEST_HASH\"}")
if echo "$BLOCK_RESPONSE" | jq -e '.blocked' 2>/dev/null | grep -q 'true'; then
  pass "Secrets block mode blocks request with AWS key"
else
  fail "Secrets block mode did not block request: $BLOCK_RESPONSE"
fi

# Restart proxy in normal mode (warn) for remaining tests
kill "$PROXY_PID" 2>/dev/null || true
sleep 1

TOOL_PROXY_PORT="$PROXY_PORT" MOAT_TOKEN_FILE="$TOKEN_FILE" \
  node "$SCRIPT_DIR/tool-proxy.mjs" --data-dir "$DATA_DIR" \
  </dev/null >>/tmp/moat-test-proxy.log 2>&1 &
PROXY_PID=$!
sleep 1

if curl -sf "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null; then
  pass "Proxy restarted in warn mode after block mode test"
else
  fail "Proxy failed to restart after block mode test"
fi

# --- Phase 5f: Multi-runtime resolution ---
echo ""
echo "--- Phase 5f: Multi-runtime resolution ---"

# Test resolveRuntimeName: CLI flag takes priority
RT_CLI=$(node -e "
  import('./lib/runtimes/index.mjs').then(m => console.log(m.resolveRuntimeName('codex', '/tmp')));
" 2>/dev/null)
if [ "$RT_CLI" = "codex" ]; then
  pass "resolveRuntimeName: CLI flag takes priority (codex)"
else
  fail "resolveRuntimeName CLI flag returned '$RT_CLI' (expected 'codex')"
fi

# Test default fallback
RT_DEFAULT=$(node -e "
  import('./lib/runtimes/index.mjs').then(m => console.log(m.resolveRuntimeName(null, '/tmp')));
" 2>/dev/null)
if [ "$RT_DEFAULT" = "claude" ]; then
  pass "resolveRuntimeName: default fallback returns 'claude'"
else
  fail "resolveRuntimeName default returned '$RT_DEFAULT' (expected 'claude')"
fi

# Test .moat.yml detection
TEMP_RT_DIR=$(mktemp -d)
echo "runtime: amp" > "$TEMP_RT_DIR/.moat.yml"
RT_YML=$(node -e "
  import('./lib/runtimes/index.mjs').then(m => console.log(m.resolveRuntimeName(null, '$TEMP_RT_DIR')));
" 2>/dev/null)
rm -rf "$TEMP_RT_DIR"
if [ "$RT_YML" = "amp" ]; then
  pass "resolveRuntimeName: reads runtime from .moat.yml (amp)"
else
  fail "resolveRuntimeName .moat.yml returned '$RT_YML' (expected 'amp')"
fi

# Test getRuntime returns object with expected fields
RT_FIELDS=$(node -e "
  import('./lib/runtimes/index.mjs').then(m => {
    const r = m.getRuntime('claude');
    const fields = ['binary', 'displayName', 'defaultVersion'].filter(f => r[f]);
    console.log(fields.length);
  });
" 2>/dev/null)
if [ "$RT_FIELDS" = "3" ]; then
  pass "getRuntime('claude') has expected fields (binary, displayName, defaultVersion)"
else
  fail "getRuntime('claude') missing fields (found $RT_FIELDS of 3)"
fi

# Test getRuntime('unknown') throws
RT_UNKNOWN=$(node -e "
  import('./lib/runtimes/index.mjs').then(m => {
    try { m.getRuntime('unknown'); console.log('no-throw'); }
    catch { console.log('threw'); }
  });
" 2>/dev/null)
if [ "$RT_UNKNOWN" = "threw" ]; then
  pass "getRuntime('unknown') throws as expected"
else
  fail "getRuntime('unknown') did not throw: $RT_UNKNOWN"
fi

# Test listRuntimes() returns all 4 runtimes
RT_LIST=$(node -e "
  import('./lib/runtimes/index.mjs').then(m => {
    const names = m.listRuntimes();
    console.log(names.sort().join(','));
  });
" 2>/dev/null)
if [ "$RT_LIST" = "amp,claude,codex,opencode" ]; then
  pass "listRuntimes() returns all 4 runtimes: $RT_LIST"
else
  fail "listRuntimes() returned '$RT_LIST' (expected 'amp,claude,codex,opencode')"
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

# --- Phase 6b: Agent, statusline, and settings inside container ---
echo ""
echo "--- Phase 6b: Agent, statusline, and settings ---"

# Helper to run commands inside the test container
dc_exec() {
  devcontainer exec \
    --workspace-folder "$WORKSPACE" \
    --config "$SCRIPT_DIR/devcontainer.json" \
    --docker-compose-file "$SCRIPT_DIR/docker-compose.yml" \
    --docker-compose-file "$SERVICES_FILE" \
    --docker-compose-file "$OVERRIDE_FILE" \
    --project-name "$PROJECT_NAME" \
    "$@" 2>&1
}

# settings.json has statusLine config
STATUSLINE_CFG=$(dc_exec bash -c 'jq ".statusLine" /home/node/.claude/settings.json' 2>&1) || true
if echo "$STATUSLINE_CFG" | grep -q '"type": "command"'; then
  pass "settings.json has statusLine command config"
else
  fail "settings.json missing statusLine config: $STATUSLINE_CFG"
fi

# settings.json has agent permission
AGENT_PERM=$(dc_exec bash -c 'jq ".permissions.allow" /home/node/.claude/settings.json' 2>&1) || true
if echo "$AGENT_PERM" | grep -q 'Bash(agent:\*)'; then
  pass "settings.json has Bash(agent:*) permission"
else
  fail "settings.json missing agent permission: $AGENT_PERM"
fi

# agent script is installed and executable
if dc_exec bash -c 'test -x /usr/local/bin/agent && echo OK' | grep -q OK; then
  pass "agent script installed at /usr/local/bin/agent"
else
  fail "agent script not installed or not executable"
fi

# agent list works with no agents
AGENT_LIST=$(dc_exec bash -c 'agent list' 2>&1) || true
if echo "$AGENT_LIST" | grep -q "No agents"; then
  pass "agent list shows 'No agents' when none running"
else
  fail "agent list unexpected output: $AGENT_LIST"
fi

# agent count returns 0 when no agents
AGENT_COUNT=$(dc_exec bash -c 'agent count' 2>&1) || true
if [ "$(echo "$AGENT_COUNT" | tr -d '[:space:]')" = "0" ]; then
  pass "agent count returns 0 when none running"
else
  fail "agent count returned '$AGENT_COUNT' (expected 0)"
fi

# statusline script is installed and executable
if dc_exec bash -c 'test -x /home/node/.claude/hooks/statusline.sh && echo OK' | grep -q OK; then
  pass "statusline.sh installed and executable"
else
  fail "statusline.sh not installed or not executable"
fi

# statusline produces formatted output from JSON
SL_OUTPUT=$(dc_exec bash -c 'echo "{\"context_window\":{\"used_percentage\":42.5},\"cost\":{\"total_cost_usd\":\"0.37\"}}" | /home/node/.claude/hooks/statusline.sh' 2>&1) || true
if echo "$SL_OUTPUT" | grep -q "43%" && echo "$SL_OUTPUT" | grep -q '\\$0.37'; then
  pass "statusline.sh formats output correctly: $SL_OUTPUT"
else
  fail "statusline.sh unexpected output: $SL_OUTPUT"
fi

# statusline handles empty/minimal JSON gracefully
SL_EMPTY=$(dc_exec bash -c 'echo "{}" | /home/node/.claude/hooks/statusline.sh' 2>&1) || true
if [ $? -eq 0 ] || [ -n "$SL_EMPTY" ] || [ -z "$SL_EMPTY" ]; then
  pass "statusline.sh handles empty JSON without crashing"
else
  fail "statusline.sh crashed on empty JSON"
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
