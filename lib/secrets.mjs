// Secrets scanning — runtime detection of leaked credentials in tool-proxy request/response flow
// Patterns ported from secrets-scan.sh (pre-commit hook)

/**
 * Secret detection patterns.
 * Each entry: { name, regex }
 * Regexes use JavaScript syntax (no PCRE lookbehinds needed here).
 */
const SECRET_PATTERNS = [
  {
    name: 'aws-access-key',
    regex: /AKIA[0-9A-Z]{16}/,
  },
  {
    name: 'api-key-assignment',
    regex: /(api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][a-zA-Z0-9/+=_-]{20,}/i,
  },
  {
    name: 'private-key',
    regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: 'github-token',
    regex: /gh[pousr]_[A-Za-z0-9_]{36,}/,
  },
  {
    name: 'anthropic-key',
    regex: /sk-ant-[a-zA-Z0-9_-]{20,}/,
  },
  {
    name: 'slack-token',
    regex: /xox[bpors]-[a-zA-Z0-9-]+/,
  },
  {
    name: 'password-assignment',
    regex: /(password|passwd|secret)\s*[:=]\s*["'][^\s"']{8,}/i,
  },
];

/**
 * Scan text for potential secrets.
 * @param {string} text — text to scan (args, stdout, stderr)
 * @returns {{ pattern: string, match: string, line: number }[]}
 */
export function scanForSecrets(text) {
  if (!text || typeof text !== 'string') return [];

  const results = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { name, regex } of SECRET_PATTERNS) {
      const match = line.match(regex);
      if (match) {
        // Truncate the match to avoid logging full secrets
        const truncated = match[0].length > 20
          ? match[0].slice(0, 12) + '...' + match[0].slice(-4)
          : match[0];
        results.push({ pattern: name, match: truncated, line: i + 1 });
      }
    }
  }

  return results;
}

/**
 * Check if blocking mode is enabled via environment variable.
 * @returns {boolean}
 */
export function isBlockingMode() {
  return process.env.MOAT_SECRETS_BLOCK === '1';
}
