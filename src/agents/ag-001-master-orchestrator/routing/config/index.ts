import { z } from 'zod';

import { RoutingConfigError, RoutingConstraintError } from '../errors/index.js';
import { ExecutionMode, RoutingStrategy } from '../types/index.js';
import type { RoutingConstraints } from '../types/index.js';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const probability = z.coerce.number().min(0).max(1);

const scoreWeight = z.coerce.number().min(0).max(1);

/**
 * Typed routing configuration (prompt §16). Thresholds reuse the orchestrator
 * spec §5 (high ≥ 0.80, low < 0.55) and feature flags from spec §22. Scoring
 * weights sum to 1 so the weighted total stays in [0,1].
 */
export const RoutingConfigSchema = z
  .object({
    ROUTING_CONFIDENCE_HIGH: probability.default(0.8),
    ROUTING_CONFIDENCE_LOW: probability.default(0.55),
    ROUTING_MAX_CANDIDATES: z.coerce.number().int().min(1).default(5),
    ROUTING_MAX_COST: probability.default(1),
    ROUTING_FALLBACK_ENABLED: booleanFromString,
    ROUTING_ESCALATION_ENABLED: booleanFromString,
    ROUTING_DEFAULT_STRATEGY: z
      .nativeEnum(RoutingStrategy)
      .default(RoutingStrategy.CapabilityMatch),
    ROUTING_DEFAULT_EXECUTION_MODE: z.nativeEnum(ExecutionMode).default(ExecutionMode.Single),
    ROUTING_MULTI_AGENT_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    ROUTING_WEIGHT_INTENT: scoreWeight.default(0.3),
    ROUTING_WEIGHT_CAPABILITY: scoreWeight.default(0.25),
    ROUTING_WEIGHT_ROLE: scoreWeight.default(0.2),
    ROUTING_WEIGHT_STATUS: scoreWeight.default(0.1),
    ROUTING_WEIGHT_PRIORITY: scoreWeight.default(0.05),
    ROUTING_WEIGHT_COST: scoreWeight.default(0.03),
    ROUTING_WEIGHT_AVAILABILITY: scoreWeight.default(0.03),
    ROUTING_WEIGHT_CONSTRAINT: scoreWeight.default(0.04),
  })
  .superRefine((config, ctx) => {
    const sum =
      config.ROUTING_WEIGHT_INTENT +
      config.ROUTING_WEIGHT_CAPABILITY +
      config.ROUTING_WEIGHT_ROLE +
      config.ROUTING_WEIGHT_STATUS +
      config.ROUTING_WEIGHT_PRIORITY +
      config.ROUTING_WEIGHT_COST +
      config.ROUTING_WEIGHT_AVAILABILITY +
      config.ROUTING_WEIGHT_CONSTRAINT;

    if (Math.abs(sum - 1) > 1e-9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ROUTING_WEIGHTS_SUM'],
        message: `Scoring weights must sum to 1, got ${sum.toFixed(4)}`,
      });
    }

    if (config.ROUTING_CONFIDENCE_LOW >= config.ROUTING_CONFIDENCE_HIGH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ROUTING_CONFIDENCE'],
        message:
          `Low threshold (${config.ROUTING_CONFIDENCE_LOW}) must be below ` +
          `high threshold (${config.ROUTING_CONFIDENCE_HIGH})`,
      });
    }
  });

export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

/** Parses and validates routing configuration from a raw environment. */
export function parseRoutingConfig(raw: NodeJS.ProcessEnv = process.env): RoutingConfig {
  const result = RoutingConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new RoutingConfigError(`Invalid routing configuration:\n${issues}`);
  }

  return result.data;
}

/** The parsed routing configuration for the running process. */
export const routingConfig: RoutingConfig = parseRoutingConfig();

/**
 * Derives a routing constraints override from the config, used to enforce
 * global limits unless the request supplies stricter values (prompt §13).
 */
export function defaultConstraints(config: RoutingConfig): RoutingConstraints {
  return {
    maxCandidates: config.ROUTING_MAX_CANDIDATES,
    maxRoutingCost: config.ROUTING_MAX_COST,
    minConfidence: config.ROUTING_CONFIDENCE_LOW,
  };
}

function assertMaxRoutingCost(value: number): void {
  if (value < 0 || value > 1) {
    throw new RoutingConstraintError(`maxRoutingCost must be in [0,1], got ${value}`);
  }
}

export { assertMaxRoutingCost };
