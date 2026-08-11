import { describe, expect, it } from 'vitest';

import { ExecutionPlanBuilder } from '../../../../../src/agents/ag-001-master-orchestrator/planning/builders/index.js';
import { parsePlanningConfig } from '../../../../../src/agents/ag-001-master-orchestrator/planning/config/index.js';
import {
  ExecutionPlanValidationError,
  UnsupportedExecutionModeError,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/errors/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import {
  RoutingStatus,
  RoutingStrategy,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { UserRole } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import {
  makeAgentRequest,
  makeIntentResult,
  makeContextSnapshot,
  makeRouteDecision,
  makeRouteCandidate,
  makeAgentConfiguration,
} from './fixtures.js';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    traceId: 'trace-1',
    request: makeAgentRequest(),
    intent: makeIntentResult(),
    context: makeContextSnapshot(),
    route: makeRouteDecision(),
    role: UserRole.Freelancer,
    ...overrides,
  };
}

describe('ExecutionPlanBuilder - single mode', () => {
  it('builds a single-step plan for a single-agent route', () => {
    const builder = new ExecutionPlanBuilder();
    const plan = builder.build(baseInput());

    expect(plan.mode).toBe(ExecutionMode.Single);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.agentId).toBe('AG-101');
    expect(plan.steps[0]?.dependencies).toHaveLength(0);
    expect(plan.statistics.stepCount).toBe(1);
    expect(plan.statistics.agentCount).toBe(1);
  });

  it('records input/output references on the single step', () => {
    const builder = new ExecutionPlanBuilder();
    const plan = builder.build(baseInput());
    const step = plan.steps[0]!;

    expect(step.input.some((reference) => reference.id === 'request.input')).toBe(true);
    expect(step.input.some((reference) => reference.id === 'context.user')).toBe(true);
    expect(step.output.some((reference) => reference.id === 'step-1.output')).toBe(true);
  });

  it('carries policy metadata and pending status', () => {
    const builder = new ExecutionPlanBuilder();
    const plan = builder.build(baseInput());
    const step = plan.steps[0]!;

    expect(step.policy.timeoutMs).toBeGreaterThan(0);
    expect(step.retry.maxRetries).toBeGreaterThanOrEqual(1);
    expect(step.status).toBe('Pending');
  });
});

describe('ExecutionPlanBuilder - sequential mode', () => {
  it('builds ordered steps with chained dependencies', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Sequential });
    const plan = builder.build(baseInput({ route }));

    expect(plan.mode).toBe(ExecutionMode.Sequential);
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[1]?.dependencies[0]?.dependsOn).toBe('step-1');
    expect(plan.steps[2]?.dependencies[0]?.dependsOn).toBe('step-2');
    expect(plan.statistics.dependencyCount).toBe(2);
  });

  it('keeps the dependency graph acyclic', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Sequential });
    const plan = builder.build(baseInput({ route }));

    expect(plan.statistics.maximumDepth).toBe(2);
    expect(plan.statistics.estimatedExecutionStages).toBe(3);
  });
});

describe('ExecutionPlanBuilder - parallel mode', () => {
  it('builds independent steps with no dependencies', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Parallel });
    const plan = builder.build(baseInput({ route }));

    expect(plan.mode).toBe(ExecutionMode.Parallel);
    expect(plan.steps).toHaveLength(3);
    expect(plan.statistics.dependencyCount).toBe(0);
    for (const step of plan.steps) {
      expect(step.dependencies).toHaveLength(0);
    }
    expect(plan.statistics.estimatedExecutionStages).toBe(1);
  });
});

describe('ExecutionPlanBuilder - conditional mode', () => {
  it('builds branches on a confidence condition', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Conditional });
    const plan = builder.build(baseInput({ route }));

    expect(plan.mode).toBe(ExecutionMode.Conditional);
    expect(plan.branches.length).toBeGreaterThanOrEqual(2);
    expect(plan.branches[0]?.condition.field).toBe('route.confidence');
    expect(plan.statistics.conditionalBranchCount).toBeGreaterThanOrEqual(2);
  });

  it('represents the else branch with a NOT condition', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Conditional });
    const plan = builder.build(baseInput({ route }));

    const elseBranch = plan.branches[1];
    expect(elseBranch?.condition.operator).toBe('NOT');
  });
});

describe('ExecutionPlanBuilder - hybrid mode', () => {
  it('builds a hybrid plan from at least 3 candidates', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Hybrid });
    const plan = builder.build(baseInput({ route }));

    expect(plan.mode).toBe(ExecutionMode.Hybrid);
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(plan.statistics.estimatedExecutionStages).toBe(3);
  });

  it('requires at least 3 candidates for hybrid mode', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({
      executionMode: ExecutionMode.Hybrid,
      candidates: [
        makeRouteCandidate(makeAgentConfiguration({ agentId: 'AG-101' })),
        makeRouteCandidate(makeAgentConfiguration({ agentId: 'AG-102' })),
      ],
    });

    expect(() => builder.build(baseInput({ route }))).toThrow(ExecutionPlanValidationError);
  });
});

describe('ExecutionPlanBuilder - transformation', () => {
  it('transforms a DIRECT route into a single plan', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({
      strategy: RoutingStrategy.Direct,
      executionMode: ExecutionMode.Single,
    });
    const plan = builder.build(baseInput({ route }));

    expect(plan.mode).toBe(ExecutionMode.Single);
    expect(plan.steps).toHaveLength(1);
  });

  it('sets the plan intent and ids from the request', () => {
    const builder = new ExecutionPlanBuilder();
    const plan = builder.build(baseInput());

    expect(plan.intentId).toBe('project.create');
    expect(plan.planId).toBe('plan-req-1');
    expect(plan.requestId).toBe('req-1');
    expect(plan.traceId).toBe('trace-1');
  });
});

describe('ExecutionPlanBuilder - validation', () => {
  it('rejects a missing agent request', () => {
    const builder = new ExecutionPlanBuilder();
    expect(() => builder.build(baseInput({ request: undefined }))).toThrow(
      ExecutionPlanValidationError,
    );
  });

  it('rejects a missing intent', () => {
    const builder = new ExecutionPlanBuilder();
    expect(() => builder.build(baseInput({ intent: undefined }))).toThrow(
      ExecutionPlanValidationError,
    );
  });

  it('rejects a missing context snapshot', () => {
    const builder = new ExecutionPlanBuilder();
    expect(() => builder.build(baseInput({ context: undefined }))).toThrow(
      ExecutionPlanValidationError,
    );
  });

  it('rejects a missing route decision', () => {
    const builder = new ExecutionPlanBuilder();
    expect(() => builder.build(baseInput({ route: undefined }))).toThrow(
      ExecutionPlanValidationError,
    );
  });

  it('rejects an invalid execution mode', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ executionMode: 'teleport' as ExecutionMode });

    expect(() => builder.build(baseInput({ route }))).toThrow(ExecutionPlanValidationError);
  });

  it('rejects a route with no selected agent in single mode', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ selectedAgent: undefined });

    expect(() => builder.build(baseInput({ route }))).toThrow(ExecutionPlanValidationError);
  });

  it('rejects an escalated route', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ status: RoutingStatus.Escalated });

    expect(() => builder.build(baseInput({ route }))).toThrow(ExecutionPlanValidationError);
  });

  it('rejects a disabled execution mode', () => {
    const config = parsePlanningConfig({ PLANNING_PARALLEL_ENABLED: 'false' });
    const builder = new ExecutionPlanBuilder({ config });
    const route = makeRouteDecision({ executionMode: ExecutionMode.Parallel });

    expect(() => builder.build(baseInput({ route }))).toThrow(UnsupportedExecutionModeError);
  });
});

describe('ExecutionPlanBuilder - determinism', () => {
  it('produces identical plans for identical inputs', () => {
    const builder = new ExecutionPlanBuilder();
    const first = builder.build(baseInput());
    const second = builder.build(baseInput());

    expect(first.planId).toBe(second.planId);
    expect(first.steps).toEqual(second.steps);
    expect(first.dependencies).toEqual(second.dependencies);
    expect(first.conditions).toEqual(second.conditions);
    expect(first.branches).toEqual(second.branches);
    expect(first.statistics).toEqual(second.statistics);
  });
});
