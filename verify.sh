#!/bin/bash
set -euo pipefail

echo "=== Moat Verification ==="

# Verify proxy is configured
if [ -z "${HTTPS_PROXY:-}" ]; then
    echo "ERROR: HTTPS_PROXY not set"
    exit 1
fi
echo "PASS: HTTPS_PROXY=${HTTPS_PROXY}"

# Verify proxy is reachable and allowed domain works
if ! curl -s --proxy "$HTTPS_PROXY" --connect-timeout 5 -o /dev/null https://api.github.com/zen; then
    echo "ERROR: Cannot reach GitHub through proxy"
    exit 1
fi
echo "PASS: GitHub API accessible through proxy"

# Verify blocked domain is denied by proxy
if curl -s --proxy "$HTTPS_PROXY" --connect-timeout 5 -o /dev/null https://example.com 2>/dev/null; then
    echo "ERROR: Moat verification failed - was able to reach https://example.com"
    exit 1
fi
echo "PASS: Blocked domain (example.com) correctly denied"

# Verify direct access (bypassing proxy) is blocked by network isolation
if curl -s --noproxy '*' --connect-timeout 5 -o /dev/null https://example.com 2>/dev/null; then
    echo "ERROR: Moat verification failed - direct access (bypassing proxy) succeeded"
    exit 1
fi
echo "PASS: Direct external access blocked (network isolation working)"

# Verify git is configured for HTTPS (use real git, not the proxy wrapper)
GIT_URL=$(/usr/bin/git config --global --get url."https://github.com/".insteadOf 2>/dev/null || true)
if [ -z "$GIT_URL" ]; then
    echo "WARNING: git HTTPS rewrite not configured"
else
    echo "PASS: Git configured to use HTTPS instead of SSH"
fi

# Verify tool proxy token is baked in
if [ -f /etc/tool-proxy-token ]; then
    echo "PASS: Tool proxy token present at /etc/tool-proxy-token"
    if curl -s --connect-timeout 5 "http://host.docker.internal:9876/health" -o /dev/null; then
        echo "PASS: Tool proxy reachable"
    else
        echo "INFO: Tool proxy not running (start it on host before using git/gh/terraform/kubectl/aws)"
    fi
else
    echo "WARNING: /etc/tool-proxy-token not found — tool proxy wrappers will not work"
fi

# Verify Docker access (only when docker: true in .moat.yml)
if [ -n "${DOCKER_HOST:-}" ]; then
    echo "--- Docker ---"
    echo "PASS: DOCKER_HOST=${DOCKER_HOST}"
    if docker info >/dev/null 2>&1; then
        echo "PASS: Docker daemon reachable through socket proxy"
    else
        echo "ERROR: DOCKER_HOST is set but docker info failed"
        exit 1
    fi
fi

# Verify IaC tools installed
echo "--- IaC tools ---"
[ -f /usr/bin/terraform ] && echo "PASS: terraform installed ($(/usr/bin/terraform version -json 2>/dev/null | jq -r '.terraform_version // "unknown"'))" || echo "INFO: terraform not installed"
[ -f /usr/local/bin/kubectl.real ] && echo "PASS: kubectl installed ($(kubectl.real version --client --short 2>/dev/null || echo 'unknown'))" || echo "INFO: kubectl not installed"
[ -d /usr/local/aws-cli ] && echo "PASS: aws-cli installed" || echo "INFO: aws-cli not installed"

echo "=== All Moat checks passed ==="
