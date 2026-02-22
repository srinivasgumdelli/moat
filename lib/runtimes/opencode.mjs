// OpenCode runtime configuration

export default {
  name: 'opencode',
  displayName: 'OpenCode',
  binary: 'opencode',
  installScript: (version) => `go install github.com/opencode-ai/opencode@${version || 'latest'}`,
  defaultVersion: 'latest',
  versionEnvVar: 'OPENCODE_VERSION',
  flags: {
    skipPermissions: null,
    addDir: null,
    prompt: null,
    allowedTools: null,
  },
  envVars: {
    ANTHROPIC_API_KEY: '${localEnv:ANTHROPIC_API_KEY}',
    OPENAI_API_KEY: '${localEnv:OPENAI_API_KEY}',
  },
  agentApiKeyEnv: 'ANTHROPIC_API_KEY',
  configDir: null,
  instructionsFile: null,
  hostConfigPaths: () => [],
  vscodeExtension: null,
  agentExec: (prompt) => ['opencode', prompt],
};
