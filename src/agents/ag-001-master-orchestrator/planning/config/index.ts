import { z } from 'zod';

import { PlanningConfigError } from '../errors/index.js';
import { FailurePolicy } from '../types/index.js';
import type { ExecutionConstraints } from '../types/index.js';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const positiveInt = z.coerce.number().int().min(1);

/**
 * Typed planning configuration (prompt §18). Limits mirror the orchestrator
 * spec §11 (fan-out bounded) and §21, defaulting to safe values. Feature
 * flags opt-in the more complex execution modes.
 */
export const PlanningConfigSchema = z.object({
  PLANNING_MAX_STEPS: positiveInt.default(10),
  PLANNING_MAX_PLAN_DEPTH: positiveInt.default(5),
  PLANNING_MAX_PARALLEL_BRANCHES: positiveInt.default(5),
  PLANNING_DEFAULT_TIMEOUT_MS: positiveInt.default(10_000),
  PLANNING_DEFAULT_RETRY_COUNT: positiveInt.default(2),
  PLANNING_DEFAULT_FAILURE_POLICY: z.nativeEnum(FailurePolicy).default(FailurePolicy.FailFast),
  PLANNING_CONDITIONAL_ENABLED: booleanFromString,
  PLANNING_PARALLEL_ENABLED: booleanFromString,
  PLANNING_HYBRID_ENABLED: booleanFromString,
  PLANNING_OPTIMIZATION_ENABLED: booleanFromString,
});

export type PlanningConfig = z.infer<typeof PlanningConfigSchema>;

/** Parses and validates planning configuration from a raw environment. */
export function parsePlanningConfig(raw: NodeJS.ProcessEnv = process.env): PlanningConfig {
  const result = PlanningConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new PlanningConfigError(`Invalid planning configuration:\n${issues}`);
  }

  return result.data;
}

/** The parsed planning configuration for the running process. */
export const planningConfig: PlanningConfig = parsePlanningConfig();

/**
 * Derives a planning constraints override from the config, used to enforce
 * global limits unless the request supplies stricter values (prompt §9).
 */
export function defaultPlanningConstraints(config: PlanningConfig): ExecutionConstraints {
  return {
    maxSteps: config.PLANNING_MAX_STEPS,
    maxDepth: config.PLANNING_MAX_PLAN_DEPTH,
    maxParallelBranches: config.PLANNING_MAX_PARALLEL_BRANCHES,
  };
}

/** Whether the given execution mode is enabled by the configuration. */
export function isModeEnabled(config: PlanningConfig, mode: string): boolean {
  switch (mode) {
    case 'parallel':
      return config.PLANNING_PARALLEL_ENABLED;
    case 'conditional':
      return config.PLANNING_CONDITIONAL_ENABLED;
    case 'hybrid':
      return config.PLANNING_HYBRID_ENABLED;
    default:
      return true;
  }
}
