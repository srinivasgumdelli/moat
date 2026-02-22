// Amp runtime configuration

export default {
  name: 'amp',
  displayName: 'Amp',
  binary: 'amp',
  installScript: (version) => `npm install -g @anthropic/amp${version ? `@${version}` : ''}`,
  defaultVersion: 'latest',
  versionEnvVar: 'AMP_VERSION',
  flags: {
    skipPermissions: '--yes',
    addDir: null,
    prompt: null,
    allowedTools: null,
  },
  envVars: {
    ANTHROPIC_API_KEY: '${localEnv:ANTHROPIC_API_KEY}',
  },
  agentApiKeyEnv: 'ANTHROPIC_API_KEY',
  configDir: null,
  instructionsFile: null,
  hostConfigPaths: () => [],
  vscodeExtension: null,
  agentExec: (prompt) => ['amp', '--yes', prompt],
};
