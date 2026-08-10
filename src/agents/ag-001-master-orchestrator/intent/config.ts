import { z } from 'zod';

import { ConfigurationError } from '../errors/index.js';
import { IntentStatus } from './types.js';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const probability = z.coerce.number().min(0).max(1);

/**
 * Typed configuration for the intent detection module. Values are driven by
 * environment variables with safe defaults derived from the orchestrator spec
 * §5 (high ≥ 0.80, low < 0.55) and feature flags from spec §22.
 */
export const IntentConfigSchema = z.object({
  INTENT_HIGH_THRESHOLD: probability.default(0.8),
  INTENT_LOW_THRESHOLD: probability.default(0.55),
  INTENT_FALLBACK_CONFIDENCE: probability.default(0.1),
  INTENT_MAX_CANDIDATES: z.coerce.number().int().min(1).default(3),
  INTENT_MULTI_INTENT_ENABLED: booleanFromString,
  INTENT_ROLE_FILTERING_ENABLED: booleanFromString,
  INTENT_DEFAULT_STATUS: z.nativeEnum(IntentStatus).default(IntentStatus.Active),
});

export type IntentConfig = z.infer<typeof IntentConfigSchema>;

/** Parses and validates the intent configuration from a raw environment. */
export function parseIntentConfig(raw: NodeJS.ProcessEnv = process.env): IntentConfig {
  const result = IntentConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new ConfigurationError(`Invalid intent configuration:\n${issues}`);
  }

  return result.data;
}

/** The parsed intent configuration for the running process. */
export const intentConfig: IntentConfig = parseIntentConfig();
