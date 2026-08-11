import { describe, expect, it } from 'vitest';

import {
  parsePlanningConfig,
  PlanningConfigSchema,
  defaultPlanningConstraints,
  isModeEnabled,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/config/index.js';
import { PlanningConfigError } from '../../../../../src/agents/ag-001-master-orchestrator/planning/errors/index.js';
import { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';

describe('parsePlanningConfig', () => {
  it('applies documented defaults for an empty environment', () => {
    const config = parsePlanningConfig({});

    expect(config.PLANNING_MAX_STEPS).toBe(10);
    expect(config.PLANNING_MAX_PLAN_DEPTH).toBe(5);
    expect(config.PLANNING_MAX_PARALLEL_BRANCHES).toBe(5);
    expect(config.PLANNING_DEFAULT_TIMEOUT_MS).toBe(10000);
    expect(config.PLANNING_DEFAULT_RETRY_COUNT).toBe(2);
    expect(config.PLANNING_DEFAULT_FAILURE_POLICY).toBe(FailurePolicy.FailFast);
    expect(config.PLANNING_CONDITIONAL_ENABLED).toBe(true);
    expect(config.PLANNING_PARALLEL_ENABLED).toBe(true);
    expect(config.PLANNING_HYBRID_ENABLED).toBe(true);
    expect(config.PLANNING_OPTIMIZATION_ENABLED).toBe(true);
  });

  it('parses explicit values from the environment', () => {
    const config = parsePlanningConfig({
      PLANNING_MAX_STEPS: '25',
      PLANNING_MAX_PLAN_DEPTH: '3',
      PLANNING_MAX_PARALLEL_BRANCHES: '8',
      PLANNING_DEFAULT_TIMEOUT_MS: '30000',
      PLANNING_DEFAULT_RETRY_COUNT: '4',
      PLANNING_DEFAULT_FAILURE_POLICY: 'FALLBACK',
      PLANNING_CONDITIONAL_ENABLED: 'false',
      PLANNING_PARALLEL_ENABLED: 'false',
      PLANNING_HYBRID_ENABLED: 'false',
      PLANNING_OPTIMIZATION_ENABLED: 'false',
    });

    expect(config.PLANNING_MAX_STEPS).toBe(25);
    expect(config.PLANNING_MAX_PLAN_DEPTH).toBe(3);
    expect(config.PLANNING_DEFAULT_RETRY_COUNT).toBe(4);
    expect(config.PLANNING_DEFAULT_FAILURE_POLICY).toBe(FailurePolicy.Fallback);
    expect(config.PLANNING_CONDITIONAL_ENABLED).toBe(false);
    expect(config.PLANNING_OPTIMIZATION_ENABLED).toBe(false);
  });

  it('rejects a non-positive max steps', () => {
    expect(() => parsePlanningConfig({ PLANNING_MAX_STEPS: '0' })).toThrow(PlanningConfigError);
  });

  it('rejects an invalid failure policy', () => {
    expect(() => parsePlanningConfig({ PLANNING_DEFAULT_FAILURE_POLICY: 'sideways' })).toThrow(
      PlanningConfigError,
    );
  });
});

describe('PlanningConfigSchema', () => {
  it('coerces string numbers', () => {
    const result = PlanningConfigSchema.safeParse({ PLANNING_MAX_STEPS: '7' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PLANNING_MAX_STEPS).toBe(7);
    }
  });
});

describe('defaultPlanningConstraints', () => {
  it('derives constraints from config limits', () => {
    const config = parsePlanningConfig({ PLANNING_MAX_STEPS: '4' });
    const constraints = defaultPlanningConstraints(config);

    expect(constraints.maxSteps).toBe(4);
    expect(constraints.maxDepth).toBe(5);
    expect(constraints.maxParallelBranches).toBe(5);
  });
});

describe('isModeEnabled', () => {
  const config = parsePlanningConfig({
    PLANNING_PARALLEL_ENABLED: 'false',
    PLANNING_CONDITIONAL_ENABLED: 'false',
    PLANNING_HYBRID_ENABLED: 'false',
  });

  it('respects feature flags', () => {
    expect(isModeEnabled(config, 'parallel')).toBe(false);
    expect(isModeEnabled(config, 'conditional')).toBe(false);
    expect(isModeEnabled(config, 'hybrid')).toBe(false);
    expect(isModeEnabled(config, 'single')).toBe(true);
    expect(isModeEnabled(config, 'sequential')).toBe(true);
  });
});
