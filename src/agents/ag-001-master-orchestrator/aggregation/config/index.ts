import { z } from 'zod';

import { AggregationConfigError } from '../errors/index.js';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const positiveInt = z.coerce.number().int().min(1);

/**
 * Typed aggregation configuration (prompt §20/§38). Limits default to safe
 * values; feature flags opt-in deduplication, retry history and diagnostics.
 */
export const AggregationConfigSchema = z.object({
  AGGREGATION_DEDUPLICATION_ENABLED: booleanFromString,
  AGGREGATION_STRICT_VALIDATION: booleanFromString,
  AGGREGATION_INCLUDE_RETRY_HISTORY: booleanFromString,
  AGGREGATION_INCLUDE_WARNINGS: booleanFromString,
  AGGREGATION_INCLUDE_ERRORS: booleanFromString,
  AGGREGATION_MAX_RESULT_COUNT: positiveInt.default(100),
  AGGREGATION_MAX_METADATA_SIZE: positiveInt.default(8_192),
});

export type AggregationConfig = z.infer<typeof AggregationConfigSchema>;

/** Parses and validates aggregation configuration from a raw environment. */
export function parseAggregationConfig(raw: NodeJS.ProcessEnv = process.env): AggregationConfig {
  const result = AggregationConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new AggregationConfigError(`Invalid aggregation configuration:\n${issues}`);
  }

  return result.data;
}

/** The parsed aggregation configuration for the running process. */
export const aggregationConfig: AggregationConfig = parseAggregationConfig();

/** Whether the given aggregation feature is enabled by the configuration. */
export function isAggregationFeatureEnabled(config: AggregationConfig, feature: string): boolean {
  switch (feature) {
    case 'deduplication':
      return config.AGGREGATION_DEDUPLICATION_ENABLED;
    case 'retryHistory':
      return config.AGGREGATION_INCLUDE_RETRY_HISTORY;
    case 'warnings':
      return config.AGGREGATION_INCLUDE_WARNINGS;
    case 'errors':
      return config.AGGREGATION_INCLUDE_ERRORS;
    default:
      return true;
  }
}
