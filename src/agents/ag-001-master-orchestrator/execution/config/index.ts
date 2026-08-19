import { z } from 'zod';

import { ExecutionConfigError } from '../errors/index.js';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const positiveInt = z.coerce.number().int().min(1);

/**
 * Typed execution configuration (prompt §22). Limits mirror the orchestrator
 * spec §11/§21 and default to safe values. Feature flags opt-in the more
 * complex behaviours.
 *
 * H-5 (hardening): EXECUTION_DEFAULT_TIMEOUT_MS is the overall-execution
 * timeout fallback used by the engine when a plan omits a
 * maxTotalExecutionTimeMs budget. EXECUTION_DEFAULT_RETRY_ATTEMPTS is a
 * validation floor: planning always supplies an explicit per-step retry
 * policy, so this default only guarantees EXECUTION_MAX_RETRY_ATTEMPTS is
 * never configured below it (see superRefine). Removing either would break
 * the documented config contract, so both are kept and enforced.
 */
export const ExecutionConfigSchema = z
  .object({
    EXECUTION_MAX_CONCURRENT_STEPS: positiveInt.default(4),
    EXECUTION_DEFAULT_TIMEOUT_MS: positiveInt.default(10_000),
    EXECUTION_MAX_TIMEOUT_MS: positiveInt.default(120_000),
    EXECUTION_DEFAULT_RETRY_ATTEMPTS: positiveInt.default(2),
    EXECUTION_MAX_RETRY_ATTEMPTS: positiveInt.default(5),
    EXECUTION_BACKOFF_BASE_MS: positiveInt.default(1_000),
    EXECUTION_BACKOFF_MAX_MS: positiveInt.default(30_000),
    EXECUTION_CANCELLATION_ENABLED: booleanFromString,
    EXECUTION_PARALLEL_ENABLED: booleanFromString,
    EXECUTION_CONDITIONAL_ENABLED: booleanFromString,
    EXECUTION_EVENTS_ENABLED: booleanFromString,
    EXECUTION_IDEMPOTENCY_ENABLED: booleanFromString,
  })
  .superRefine((config, ctx) => {
    if (config.EXECUTION_MAX_TIMEOUT_MS < config.EXECUTION_DEFAULT_TIMEOUT_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EXECUTION_TIMEOUT'],
        message:
          'Maximum timeout must be >= default timeout ' +
          `(${config.EXECUTION_MAX_TIMEOUT_MS} < ${config.EXECUTION_DEFAULT_TIMEOUT_MS})`,
      });
    }

    if (config.EXECUTION_MAX_RETRY_ATTEMPTS < config.EXECUTION_DEFAULT_RETRY_ATTEMPTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EXECUTION_RETRY'],
        message:
          'Maximum retry attempts must be >= default retry attempts ' +
          `(${config.EXECUTION_MAX_RETRY_ATTEMPTS} < ${config.EXECUTION_DEFAULT_RETRY_ATTEMPTS})`,
      });
    }

    if (config.EXECUTION_BACKOFF_MAX_MS < config.EXECUTION_BACKOFF_BASE_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EXECUTION_BACKOFF'],
        message:
          'Maximum backoff must be >= base backoff ' +
          `(${config.EXECUTION_BACKOFF_MAX_MS} < ${config.EXECUTION_BACKOFF_BASE_MS})`,
      });
    }
  });

export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

/** Parses and validates execution configuration from a raw environment. */
export function parseExecutionConfig(raw: NodeJS.ProcessEnv = process.env): ExecutionConfig {
  const result = ExecutionConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new ExecutionConfigError(`Invalid execution configuration:\n${issues}`);
  }

  return result.data;
}

/** The parsed execution configuration for the running process. */
export const executionConfig: ExecutionConfig = parseExecutionConfig();

/** Whether the given feature is enabled by the execution configuration. */
export function isExecutionFeatureEnabled(config: ExecutionConfig, feature: string): boolean {
  switch (feature) {
    case 'parallel':
      return config.EXECUTION_PARALLEL_ENABLED;
    case 'conditional':
      return config.EXECUTION_CONDITIONAL_ENABLED;
    case 'cancellation':
      return config.EXECUTION_CANCELLATION_ENABLED;
    case 'events':
      return config.EXECUTION_EVENTS_ENABLED;
    case 'idempotency':
      return config.EXECUTION_IDEMPOTENCY_ENABLED;
    default:
      return true;
  }
}
