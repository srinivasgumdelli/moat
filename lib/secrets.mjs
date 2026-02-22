// Secrets scanning — runtime detection of leaked credentials in tool-proxy request/response flow
// Patterns ported from secrets-scan.sh (pre-commit hook)

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';

/**
 * Secret detection patterns.
 * Each entry: { name, regex }
 * Regexes use JavaScript syntax (no PCRE lookbehinds needed here).
 */
export const SECRET_PATTERNS = [
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
  {
    name: 'openai-key',
    regex: /sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}/,
  },
  {
    name: 'gcp-service-key',
    regex: /"type"\s*:\s*"service_account"/,
  },
  {
    name: 'jwt-token',
    regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/,
  },
  {
    name: 'generic-secret-env',
    regex: /[A-Z_]*(SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z_]*\s*=\s*["'][^\s"']{8,}/,
  },
];

/**
 * Load custom secret patterns from .moat.yml in the workspace.
 * Returns the merged array of built-in + custom patterns.
 * @param {string} workspace — workspace directory path
 * @returns {{ name: string, regex: RegExp }[]}
 */
export function loadCustomPatterns(workspace) {
  if (!workspace) return [...SECRET_PATTERNS];

  const moatYml = join(workspace, '.moat.yml');
  if (!existsSync(moatYml)) return [...SECRET_PATTERNS];

  try {
    const content = readFileSync(moatYml, 'utf-8');
    const config = parseYaml(content);

    if (!config.secrets?.patterns || !Array.isArray(config.secrets.patterns)) {
      return [...SECRET_PATTERNS];
    }

    const custom = [];
    for (const entry of config.secrets.patterns) {
      if (!entry.name || !entry.regex) continue;
      try {
        custom.push({ name: entry.name, regex: new RegExp(entry.regex) });
      } catch {
        process.stderr.write(`[secrets] Invalid custom pattern '${entry.name}': bad regex, skipping\n`);
      }
    }

    return [...SECRET_PATTERNS, ...custom];
  } catch {
    return [...SECRET_PATTERNS];
  }
}

/**
 * Scan text for potential secrets.
 * @param {string} text — text to scan (args, stdout, stderr)
 * @param {{ name: string, regex: RegExp }[]} [customPatterns] — optional merged patterns (from loadCustomPatterns)
 * @returns {{ pattern: string, match: string, line: number }[]}
 */
export function scanForSecrets(text, customPatterns) {
  if (!text || typeof text !== 'string') return [];

  const patterns = customPatterns || SECRET_PATTERNS;
  const results = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { name, regex } of patterns) {
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
