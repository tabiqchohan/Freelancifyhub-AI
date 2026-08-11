import { describe, expect, it } from 'vitest';

import {
  resolveStrategy,
  SinglePlanningStrategy,
  SequentialPlanningStrategy,
  ParallelPlanningStrategy,
  ConditionalPlanningStrategy,
  HybridPlanningStrategy,
  strategies,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/strategies/index.js';
import { parsePlanningConfig } from '../../../../../src/agents/ag-001-master-orchestrator/planning/config/index.js';
import { UnsupportedExecutionModeError } from '../../../../../src/agents/ag-001-master-orchestrator/planning/errors/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { UserRole } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import {
  makeAgentRequest,
  makeIntentResult,
  makeContextSnapshot,
  makeRouteDecision,
  makeRouteCandidate,
  makeAgentConfiguration,
} from './fixtures.js';

function inputFor(route = makeRouteDecision()) {
  return {
    request: {
      requestId: 'req-1',
      traceId: 'trace-1',
      request: makeAgentRequest(),
      intent: makeIntentResult(),
      context: makeContextSnapshot(),
      route,
      role: UserRole.Freelancer,
    },
    config: parsePlanningConfig({}),
  };
}

describe('strategies registry', () => {
  it('exposes all five strategies', () => {
    expect(Object.keys(strategies).sort()).toEqual(
      ['single', 'sequential', 'parallel', 'conditional', 'hybrid'].sort(),
    );
    expect(new SinglePlanningStrategy().mode).toBe(ExecutionMode.Single);
    expect(new SequentialPlanningStrategy().mode).toBe(ExecutionMode.Sequential);
    expect(new ParallelPlanningStrategy().mode).toBe(ExecutionMode.Parallel);
    expect(new ConditionalPlanningStrategy().mode).toBe(ExecutionMode.Conditional);
    expect(new HybridPlanningStrategy().mode).toBe(ExecutionMode.Hybrid);
  });

  it('resolves a strategy by mode', () => {
    expect(resolveStrategy(ExecutionMode.Parallel).name).toBe('parallel-planning-strategy');
  });
});

describe('SequentialPlanningStrategy', () => {
  it('produces ordered steps with chained dependencies', () => {
    const strategy = new SequentialPlanningStrategy();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Sequential });
    const output = strategy.plan(inputFor(route));

    expect(output.steps).toHaveLength(3);
    expect(output.dependencies).toHaveLength(2);
    expect(output.steps[1]?.dependencies[0]?.dependsOn).toBe('step-1');
  });
});

describe('ParallelPlanningStrategy', () => {
  it('produces independent steps', () => {
    const strategy = new ParallelPlanningStrategy();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Parallel });
    const output = strategy.plan(inputFor(route));

    expect(output.steps).toHaveLength(3);
    expect(output.dependencies).toHaveLength(0);
    for (const step of output.steps) {
      expect(step.dependencies).toHaveLength(0);
    }
  });
});

describe('ConditionalPlanningStrategy', () => {
  it('produces branches with conditions', () => {
    const strategy = new ConditionalPlanningStrategy();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Conditional });
    const output = strategy.plan(inputFor(route));

    expect(output.branches.length).toBeGreaterThanOrEqual(2);
    expect(output.conditions[0]?.field).toBe('route.confidence');
    expect(output.conditions[0]?.value).toBe(0.55);
  });
});

describe('HybridPlanningStrategy', () => {
  it('produces a sequential-parallel-conditional mix', () => {
    const strategy = new HybridPlanningStrategy();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Hybrid });
    const output = strategy.plan(inputFor(route));

    expect(output.steps).toHaveLength(3);
    expect(output.dependencies).toHaveLength(2);
    expect(output.steps[1]?.dependencies[0]?.dependsOn).toBe('step-1');
    expect(output.steps[2]?.dependencies[0]?.dependsOn).toBe('step-2');
  });
});

describe('resolveStrategy', () => {
  it('rejects an unsupported mode', () => {
    expect(() => resolveStrategy('teleport' as ExecutionMode)).toThrow(
      UnsupportedExecutionModeError,
    );
  });
});

describe('route-to-plan strategy selection', () => {
  it('uses candidates for multi-agent modes', () => {
    const strategy = new SequentialPlanningStrategy();
    const route = makeRouteDecision({
      executionMode: ExecutionMode.Sequential,
      candidates: [
        makeRouteCandidate(makeAgentConfiguration({ agentId: 'AG-900' })),
        makeRouteCandidate(makeAgentConfiguration({ agentId: 'AG-901' })),
      ],
    });
    const output = strategy.plan(inputFor(route));

    expect(output.steps[0]?.agentId).toBe('AG-900');
    expect(output.steps[1]?.agentId).toBe('AG-901');
  });
});
