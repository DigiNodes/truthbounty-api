export const CONFIGURED_AI_PROVIDERS = ['openai', 'anthropic', 'mock'] as const;

export type ConfiguredAiProvider = (typeof CONFIGURED_AI_PROVIDERS)[number];

export const AI_PROVIDER_SECRETS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
} as const;

export function isRealAiProvider(
  provider: unknown,
): provider is keyof typeof AI_PROVIDER_SECRETS {
  return provider === 'openai' || provider === 'anthropic';
}

export function normalizeAiProvider(value: unknown): ConfiguredAiProvider | undefined {
  return CONFIGURED_AI_PROVIDERS.find((provider) => provider === value);
}

export function providerSecretKey(
  provider: ConfiguredAiProvider,
): (typeof AI_PROVIDER_SECRETS)[keyof typeof AI_PROVIDER_SECRETS] | undefined {
  return isRealAiProvider(provider) ? AI_PROVIDER_SECRETS[provider] : undefined;
}

export function isDeployedEnvironment(nodeEnv: unknown): boolean {
  return nodeEnv === 'staging' || nodeEnv === 'production';
}

export function mockProviderAllowed(
  nodeEnv: unknown,
  localDevMode: unknown,
): boolean {
  if (
    typeof nodeEnv !== 'string' ||
    nodeEnv === 'local' ||
    nodeEnv === 'test'
  )
    return true;
  if (nodeEnv !== 'development') return false;
  return localDevMode === true || localDevMode === 'true';
}

export function redactSecrets(
  message: string,
  secrets: readonly unknown[],
): string {
  let redacted = message;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.trim())
      redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted.replace(
    /\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}\b/g,
    '[REDACTED]',
  );
}
