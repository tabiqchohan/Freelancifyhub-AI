import type { LLMConfig } from './schema.js';
import { LLMConfigSchema } from './schema.js';
import { LLM_PROVIDER_HTTP } from '../constants.js';
import { LLMConfigurationError } from '../errors/index.js';

export { LLMConfigSchema };
export type { LLMConfig };

/**
 * Parses and validates the LLM configuration from a raw environment.
 * Fail-closed: invalid values throw {@link LLMConfigurationError}. A real
 * (HTTP) provider that is enabled without credentials also fails closed so the
 * application never boots into a silently-misconfigured reasoning path.
 * A disabled configuration never requires credentials.
 */
export function parseLlmConfig(raw: NodeJS.ProcessEnv = process.env): LLMConfig {
  const result = LLMConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new LLMConfigurationError(`Invalid LLM configuration:\n${issues}`);
  }

  const config = result.data;

  if (config.LLM_ENABLED && config.LLM_PROVIDER === LLM_PROVIDER_HTTP && !hasApiKey(config)) {
    throw new LLMConfigurationError(
      'LLM is enabled with the http provider but no LLM_API_KEY is configured',
      { details: { provider: config.LLM_PROVIDER, model: config.LLM_MODEL } },
    );
  }

  return config;
}

function hasApiKey(config: LLMConfig): boolean {
  return typeof config.LLM_API_KEY === 'string' && config.LLM_API_KEY.trim().length > 0;
}
