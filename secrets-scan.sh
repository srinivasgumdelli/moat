#!/bin/bash
# Pre-commit hook: scan staged files for potential secrets
# Lightweight pattern-based scanner — no external dependencies needed.

set -euo pipefail

# Patterns that indicate secrets (case-insensitive where noted)
PATTERNS=(
  # AWS keys
  'AKIA[0-9A-Z]{16}'
  # Generic API keys / tokens in assignments
  '(?i)(api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["\x27][a-zA-Z0-9/+=_-]{20,}'
  # Private keys
  '-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'
  # GitHub tokens
  'gh[pousr]_[A-Za-z0-9_]{36,}'
  # Anthropic keys
  'sk-ant-[a-zA-Z0-9_-]{20,}'
  # Slack tokens
  'xox[bpors]-[a-zA-Z0-9-]+'
  # Generic high-entropy strings in common secret variable names
  '(?i)(password|passwd|secret)\s*[:=]\s*["\x27][^\s"'\'']{8,}'
)

# Only scan staged files (not the full working tree)
files=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
if [ -z "$files" ]; then
  exit 0
fi

# Skip binary files and common non-secret files
skip_extensions='\.png$|\.jpg$|\.jpeg$|\.gif$|\.ico$|\.woff2?$|\.ttf$|\.eot$|\.pdf$|\.zip$|\.tar$|\.gz$|\.lock$'

found=0
for pattern in "${PATTERNS[@]}"; do
  # Use grep -P (PCRE) if available, fall back to -E (ERE)
  for file in $files; do
    # Skip binary-ish files
    if echo "$file" | grep -qE "$skip_extensions"; then
      continue
    fi
    # Only scan staged content (not working tree)
    matches=$(git show ":${file}" 2>/dev/null | grep -nP "$pattern" 2>/dev/null || true)
    if [ -z "$matches" ]; then
      # Fallback to ERE for patterns that don't use PCRE features
      matches=$(git show ":${file}" 2>/dev/null | grep -nE "$pattern" 2>/dev/null || true)
    fi
    if [ -n "$matches" ]; then
      if [ "$found" -eq 0 ]; then
        echo ""
        echo "[secrets-scan] Potential secrets detected in staged files:"
        echo ""
      fi
      while IFS= read -r line; do
        echo "  $file:$line"
      done <<< "$matches"
      found=1
    fi
  done
done

if [ "$found" -eq 1 ]; then
  echo ""
  echo "[secrets-scan] Remove secrets before committing, or use 'git commit --no-verify' to bypass."
  exit 1
fi
