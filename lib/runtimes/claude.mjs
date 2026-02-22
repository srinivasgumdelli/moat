// Claude Code runtime configuration

import { join } from 'node:path';

export default {
  name: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  installScript: (version) => `curl -fsSL https://claude.ai/install.sh | bash -s ${version}`,
  defaultVersion: '2.1.42',
  versionEnvVar: 'CLAUDE_CODE_VERSION',
  flags: {
    skipPermissions: '--dangerously-skip-permissions',
    addDir: '--add-dir',
    prompt: '-p',
    allowedTools: '--allowedTools',
  },
  envVars: {
    ANTHROPIC_API_KEY: '${localEnv:ANTHROPIC_API_KEY}',
  },
  agentApiKeyEnv: 'ANTHROPIC_API_KEY',
  configDir: '.claude',
  instructionsFile: 'CLAUDE.md',
  hostConfigPaths: (home) => [
    join(home, '.claude.json'),
    join(home, '.claude', '.claude.json'),
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
  ],
  vscodeExtension: 'anthropic.claude-code',
  agentExec: (prompt, tools) => ['claude', '-p', prompt, '--allowedTools', tools],
};
