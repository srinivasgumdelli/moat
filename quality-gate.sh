#!/bin/bash
# quality-gate.sh — enforce diagnostics/tests/build before git push
# Installed at /usr/local/bin/quality-gate in the container.
# Called from git-proxy-wrapper.sh before proxying push.
# Reads config from /home/node/.claude/quality-gate-config.json
# Detects ALL project types in workspace and runs checks for each.

set -euo pipefail

WORKSPACE="${1:-.}"
CONFIG_FILE="/home/node/.claude/quality-gate-config.json"
PROXY_URL="http://host.docker.internal:9876"
PROXY_TOKEN=$(cat /etc/tool-proxy-token 2>/dev/null || true)

# --- Helpers ---

log() { echo "[quality-gate] $*" >&2; }
fail() { echo "[quality-gate] FAILED: $*" >&2; }

audit_post() {
  local event_type="$1"
  local payload="$2"
  [ -z "$PROXY_TOKEN" ] && return 0
  curl -s -X POST "${PROXY_URL}/audit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${PROXY_TOKEN}" \
    -d "{\"type\":\"${event_type}\",\"workspace_hash\":\"${MOAT_WORKSPACE_HASH:-}\",\"payload\":${payload}}" \
    >/dev/null 2>&1 || true
}

read_config() {
  local key="$1"
  local default="$2"
  if [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
    local val
    val=$(jq -r ".${key} // \"${default}\"" "$CONFIG_FILE" 2>/dev/null)
    echo "${val:-$default}"
  else
    echo "$default"
  fi
}

# --- Skip check ---

if [ "${MOAT_SKIP_GATES:-}" = "1" ]; then
  log "Skipped (MOAT_SKIP_GATES=1)"
  audit_post "quality_gate.skipped" '{"reason":"MOAT_SKIP_GATES=1"}'
  exit 0
fi

# --- Read config ---

DIAGNOSTICS=$(read_config "diagnostics" "true")
TESTS=$(read_config "tests" "true")
BUILD=$(read_config "build" "false")
BUILD_COMMAND=$(read_config "build_command" "null")

cd "$WORKSPACE"

# --- Detection + check execution ---

CHECKS_RUN=0
CHECKS_PASSED=0
CHECKS_FAILED=0
CHECKS_SKIPPED=0
RESULTS=""

run_check() {
  local check_type="$1"
  local check_name="$2"
  shift 2
  CHECKS_RUN=$((CHECKS_RUN + 1))
  log "Running ${check_type}: ${check_name}..."
  if "$@" >/dev/null 2>&1; then
    CHECKS_PASSED=$((CHECKS_PASSED + 1))
    RESULTS="${RESULTS}{\"type\":\"${check_type}\",\"name\":\"${check_name}\",\"status\":\"pass\"},"
    log "  PASS: ${check_name}"
  else
    CHECKS_FAILED=$((CHECKS_FAILED + 1))
    RESULTS="${RESULTS}{\"type\":\"${check_type}\",\"name\":\"${check_name}\",\"status\":\"fail\"},"
    fail "${check_name}"
    # Show the actual output for the user
    log "  Re-running with output:"
    "$@" >&2 2>&1 || true
  fi
}

skip_check() {
  local check_type="$1"
  local check_name="$2"
  local reason="$3"
  CHECKS_SKIPPED=$((CHECKS_SKIPPED + 1))
  RESULTS="${RESULTS}{\"type\":\"${check_type}\",\"name\":\"${check_name}\",\"status\":\"skip\",\"reason\":\"${reason}\"},"
}

# --- TypeScript / JavaScript ---

if [ -f "tsconfig.json" ] || [ -f "package.json" ]; then
  if [ "$DIAGNOSTICS" = "true" ]; then
    if [ -f "tsconfig.json" ] && [ -f "node_modules/.bin/tsc" ]; then
      run_check "diagnostics" "tsc --noEmit" npx tsc --noEmit
    elif [ -f "tsconfig.json" ]; then
      skip_check "diagnostics" "tsc --noEmit" "tsc not installed"
    fi
  fi
  if [ "$TESTS" = "true" ]; then
    if [ -f "node_modules/.bin/vitest" ]; then
      run_check "tests" "vitest" npx vitest run
    elif [ -f "node_modules/.bin/jest" ]; then
      run_check "tests" "jest" npx jest --passWithNoTests
    else
      skip_check "tests" "js-tests" "no test runner found"
    fi
  fi
fi

# --- Python ---

if [ -f "pyproject.toml" ] || [ -f "setup.py" ] || [ -f "requirements.txt" ]; then
  if [ "$DIAGNOSTICS" = "true" ]; then
    if command -v pyright >/dev/null 2>&1; then
      run_check "diagnostics" "pyright" pyright
    else
      skip_check "diagnostics" "pyright" "pyright not installed"
    fi
  fi
  if [ "$TESTS" = "true" ]; then
    if command -v python3 >/dev/null 2>&1 && python3 -c "import pytest" 2>/dev/null; then
      run_check "tests" "pytest" python3 -m pytest --no-header -q
    else
      skip_check "tests" "pytest" "pytest not installed"
    fi
  fi
fi

# --- Go ---

if [ -f "go.mod" ]; then
  if [ "$DIAGNOSTICS" = "true" ]; then
    if command -v golangci-lint >/dev/null 2>&1; then
      run_check "diagnostics" "golangci-lint" golangci-lint run ./...
    elif command -v go >/dev/null 2>&1; then
      run_check "diagnostics" "go vet" go vet ./...
    else
      skip_check "diagnostics" "go-lint" "golangci-lint/go not installed"
    fi
  fi
  if [ "$TESTS" = "true" ]; then
    if command -v go >/dev/null 2>&1; then
      run_check "tests" "go test" go test ./...
    else
      skip_check "tests" "go test" "go not installed"
    fi
  fi
fi

# --- Terraform ---

if compgen -G "*.tf" >/dev/null 2>&1 || compgen -G "**/*.tf" >/dev/null 2>&1; then
  if [ "$DIAGNOSTICS" = "true" ]; then
    if command -v terraform >/dev/null 2>&1; then
      run_check "diagnostics" "terraform validate" terraform validate
      run_check "diagnostics" "terraform fmt -check" terraform fmt -check
    else
      skip_check "diagnostics" "terraform" "terraform not available"
    fi
  fi
fi

# --- Dockerfile ---

if [ -f "Dockerfile" ]; then
  if [ "$DIAGNOSTICS" = "true" ]; then
    if command -v hadolint >/dev/null 2>&1; then
      run_check "diagnostics" "hadolint" hadolint Dockerfile
    else
      skip_check "diagnostics" "hadolint" "hadolint not installed"
    fi
  fi
fi

# --- Kubernetes ---

detect_k8s() {
  [ -d "k8s" ] && return 0
  [ -d "manifests" ] && return 0
  # Check for YAML files with apiVersion field
  for f in *.yaml *.yml; do
    [ -f "$f" ] && grep -q "^apiVersion:" "$f" 2>/dev/null && return 0
  done
  return 1
}

if detect_k8s; then
  if [ "$DIAGNOSTICS" = "true" ]; then
    if command -v kubectl >/dev/null 2>&1; then
      # Find all K8s manifests and validate with --dry-run=client
      k8s_ok=true
      for dir in k8s manifests .; do
        [ -d "$dir" ] || continue
        for f in "$dir"/*.yaml "$dir"/*.yml; do
          [ -f "$f" ] || continue
          grep -q "^apiVersion:" "$f" 2>/dev/null || continue
          if ! kubectl apply --dry-run=client -f "$f" >/dev/null 2>&1; then
            k8s_ok=false
          fi
        done
      done
      if $k8s_ok; then
        CHECKS_RUN=$((CHECKS_RUN + 1))
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
        RESULTS="${RESULTS}{\"type\":\"diagnostics\",\"name\":\"kubectl dry-run\",\"status\":\"pass\"},"
        log "  PASS: kubectl dry-run"
      else
        CHECKS_RUN=$((CHECKS_RUN + 1))
        CHECKS_FAILED=$((CHECKS_FAILED + 1))
        RESULTS="${RESULTS}{\"type\":\"diagnostics\",\"name\":\"kubectl dry-run\",\"status\":\"fail\"},"
        fail "kubectl dry-run"
      fi
    else
      skip_check "diagnostics" "kubectl dry-run" "kubectl not available"
    fi
  fi
fi

# --- Custom build step ---

if [ "$BUILD" = "true" ] && [ "$BUILD_COMMAND" != "null" ] && [ -n "$BUILD_COMMAND" ]; then
  CHECKS_RUN=$((CHECKS_RUN + 1))
  log "Running build: ${BUILD_COMMAND}..."
  if eval "$BUILD_COMMAND" >/dev/null 2>&1; then
    CHECKS_PASSED=$((CHECKS_PASSED + 1))
    RESULTS="${RESULTS}{\"type\":\"build\",\"name\":\"custom build\",\"status\":\"pass\"},"
    log "  PASS: custom build"
  else
    CHECKS_FAILED=$((CHECKS_FAILED + 1))
    RESULTS="${RESULTS}{\"type\":\"build\",\"name\":\"custom build\",\"status\":\"fail\"},"
    fail "custom build: ${BUILD_COMMAND}"
    # Show build output
    log "  Re-running with output:"
    eval "$BUILD_COMMAND" >&2 2>&1 || true
  fi
fi

# --- Summary ---

# Trim trailing comma from RESULTS
RESULTS="${RESULTS%,}"

if [ "$CHECKS_RUN" -eq 0 ]; then
  log "No project types detected — skipping gates"
  audit_post "quality_gate.result" "{\"outcome\":\"pass\",\"reason\":\"no checks to run\",\"checks_run\":0,\"checks_passed\":0,\"checks_failed\":0,\"checks_skipped\":${CHECKS_SKIPPED}}"
  exit 0
fi

audit_post "quality_gate.result" "{\"outcome\":\"$([ $CHECKS_FAILED -eq 0 ] && echo pass || echo fail)\",\"checks_run\":${CHECKS_RUN},\"checks_passed\":${CHECKS_PASSED},\"checks_failed\":${CHECKS_FAILED},\"checks_skipped\":${CHECKS_SKIPPED},\"results\":[${RESULTS}]}"

if [ "$CHECKS_FAILED" -gt 0 ]; then
  log ""
  log "Quality gate BLOCKED push: ${CHECKS_FAILED} check(s) failed, ${CHECKS_PASSED} passed, ${CHECKS_SKIPPED} skipped"
  log "Fix the issues above, or set MOAT_SKIP_GATES=1 to bypass"
  exit 1
fi

log "All checks passed (${CHECKS_PASSED} passed, ${CHECKS_SKIPPED} skipped)"
exit 0
