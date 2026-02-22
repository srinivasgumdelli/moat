// Codex CLI runtime configuration

export default {
  name: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  installScript: (version) => `npm install -g @openai/codex${version ? `@${version}` : ''}`,
  defaultVersion: 'latest',
  versionEnvVar: 'CODEX_VERSION',
  flags: {
    skipPermissions: '--full-auto',
    addDir: null,
    prompt: null,
    allowedTools: null,
  },
  envVars: {
    OPENAI_API_KEY: '${localEnv:OPENAI_API_KEY}',
  },
  agentApiKeyEnv: 'OPENAI_API_KEY',
  configDir: null,
  instructionsFile: null,
  hostConfigPaths: () => [],
  vscodeExtension: null,
  agentExec: (prompt) => ['codex', '--full-auto', prompt],
};
