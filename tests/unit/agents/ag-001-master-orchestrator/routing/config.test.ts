import { describe, expect, it } from 'vitest';

import {
  parseRoutingConfig,
  RoutingConfigSchema,
  defaultConstraints,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/config/index.js';
import {
  RoutingConfigError,
  RoutingConstraintError,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/errors/index.js';
import {
  ExecutionMode,
  RoutingStrategy,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';

describe('parseRoutingConfig', () => {
  it('applies documented defaults for an empty environment', () => {
    const config = parseRoutingConfig({});

    expect(config.ROUTING_CONFIDENCE_HIGH).toBe(0.8);
    expect(config.ROUTING_CONFIDENCE_LOW).toBe(0.55);
    expect(config.ROUTING_MAX_CANDIDATES).toBe(5);
    expect(config.ROUTING_FALLBACK_ENABLED).toBe(true);
    expect(config.ROUTING_ESCALATION_ENABLED).toBe(true);
    expect(config.ROUTING_DEFAULT_STRATEGY).toBe(RoutingStrategy.CapabilityMatch);
    expect(config.ROUTING_DEFAULT_EXECUTION_MODE).toBe(ExecutionMode.Single);
    expect(config.ROUTING_MULTI_AGENT_ENABLED).toBe(false);
  });

  it('parses explicit values from the environment', () => {
    const config = parseRoutingConfig({
      ROUTING_CONFIDENCE_HIGH: '0.9',
      ROUTING_CONFIDENCE_LOW: '0.6',
      ROUTING_MAX_CANDIDATES: '3',
      ROUTING_FALLBACK_ENABLED: 'false',
      ROUTING_ESCALATION_ENABLED: 'false',
      ROUTING_DEFAULT_STRATEGY: 'priority',
      ROUTING_DEFAULT_EXECUTION_MODE: 'sequential',
      ROUTING_MULTI_AGENT_ENABLED: 'true',
    });

    expect(config.ROUTING_CONFIDENCE_HIGH).toBe(0.9);
    expect(config.ROUTING_CONFIDENCE_LOW).toBe(0.6);
    expect(config.ROUTING_MAX_CANDIDATES).toBe(3);
    expect(config.ROUTING_FALLBACK_ENABLED).toBe(false);
    expect(config.ROUTING_MULTI_AGENT_ENABLED).toBe(true);
    expect(config.ROUTING_DEFAULT_STRATEGY).toBe(RoutingStrategy.Priority);
  });

  it('rejects weights that do not sum to 1', () => {
    expect(() => parseRoutingConfig({ ROUTING_WEIGHT_INTENT: '0.1' })).toThrow(RoutingConfigError);
  });

  it('rejects a low threshold at or above the high threshold', () => {
    expect(() =>
      parseRoutingConfig({
        ROUTING_CONFIDENCE_HIGH: '0.8',
        ROUTING_CONFIDENCE_LOW: '0.8',
      }),
    ).toThrow(RoutingConfigError);
  });

  it('rejects an invalid strategy value', () => {
    expect(() => parseRoutingConfig({ ROUTING_DEFAULT_STRATEGY: 'sideways' })).toThrow(
      RoutingConfigError,
    );
  });

  it('accepts a valid custom weight split', () => {
    const config = parseRoutingConfig({
      ROUTING_WEIGHT_INTENT: '0.2',
      ROUTING_WEIGHT_CAPABILITY: '0.2',
      ROUTING_WEIGHT_ROLE: '0.2',
      ROUTING_WEIGHT_STATUS: '0.1',
      ROUTING_WEIGHT_PRIORITY: '0.1',
      ROUTING_WEIGHT_COST: '0.1',
      ROUTING_WEIGHT_AVAILABILITY: '0.05',
      ROUTING_WEIGHT_CONSTRAINT: '0.05',
    });

    expect(config.ROUTING_WEIGHT_INTENT).toBe(0.2);
  });
});

describe('RoutingConfigSchema', () => {
  it('parses with coercion and defaults', () => {
    const result = RoutingConfigSchema.safeParse({ ROUTING_MAX_CANDIDATES: '7' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ROUTING_MAX_CANDIDATES).toBe(7);
      expect(result.data.ROUTING_CONFIDENCE_HIGH).toBe(0.8);
    }
  });

  it('rejects negative candidate counts', () => {
    const result = RoutingConfigSchema.safeParse({ ROUTING_MAX_CANDIDATES: '-1' });

    expect(result.success).toBe(false);
  });
});

describe('defaultConstraints', () => {
  it('derives constraints from config limits', () => {
    const config = parseRoutingConfig({ ROUTING_MAX_CANDIDATES: '3' });
    const constraints = defaultConstraints(config);

    expect(constraints.maxCandidates).toBe(3);
    expect(constraints.maxRoutingCost).toBe(1);
    expect(constraints.minConfidence).toBe(0.55);
  });
});

describe('maxRoutingCost validation', () => {
  it('accepts a valid cost', () => {
    const config = parseRoutingConfig({});
    expect(defaultConstraints(config).maxRoutingCost).toBe(1);
  });

  it('rejects an out-of-range cost via the exported helper', async () => {
    const { assertMaxRoutingCost } =
      await import('../../../../../src/agents/ag-001-master-orchestrator/routing/config/index.js');
    expect(() => assertMaxRoutingCost(1.5)).toThrow(RoutingConstraintError);
    expect(() => assertMaxRoutingCost(-0.1)).toThrow(RoutingConstraintError);
  });
});
