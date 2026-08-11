import { describe, expect, it } from 'vitest';

import { ExecutionPlanBuilder } from '../../../../../src/agents/ag-001-master-orchestrator/planning/builders/index.js';
import { parsePlanningConfig } from '../../../../../src/agents/ag-001-master-orchestrator/planning/config/index.js';
import { ExecutionPlanLimitError } from '../../../../../src/agents/ag-001-master-orchestrator/planning/errors/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { UserRole } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { AgentStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { IntentId } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import {
  makeAgentRequest,
  makeIntentResult,
  makeIntentDefinition,
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

describe('failure policies', () => {
  it('applies the configured default failure policy', () => {
    const builder = new ExecutionPlanBuilder();
    const plan = builder.build(baseInput());

    expect(plan.policy.failureBehavior).toBe('FAIL_FAST');
    expect(plan.steps[0]?.policy.failureBehavior).toBe('FAIL_FAST');
  });

  it('supports ESCALATE as a configured default', () => {
    const config = parsePlanningConfig({ PLANNING_DEFAULT_FAILURE_POLICY: 'ESCALATE' });
    const builder = new ExecutionPlanBuilder({ config });
    const plan = builder.build(baseInput());

    expect(plan.policy.failureBehavior).toBe('ESCALATE');
  });

  it('records stop-on-failure and fallback-allowed metadata', () => {
    const builder = new ExecutionPlanBuilder();
    const plan = builder.build(baseInput());

    expect(plan.policy.stopOnFailure).toBe(true);
    expect(plan.policy.continueOnFailure).toBe(false);
    expect(plan.policy.fallbackAllowed).toBe(true);
  });
});

describe('input/output references', () => {
  it('includes request, context and route references', () => {
    const builder = new ExecutionPlanBuilder();
    const plan = builder.build(baseInput());

    const ids = plan.steps[0]!.input.map((reference) => reference.id);
    expect(ids).toContain('request.input');
    expect(ids).toContain('context.user');
    expect(ids).toContain('route.metadata');
  });

  it('references previous step output in sequential plans', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Sequential });
    const plan = builder.build(baseInput({ route }));

    expect(plan.steps[1]!.input.some((reference) => reference.id === 'step-1.output')).toBe(true);
  });
});

describe('maximum steps limit', () => {
  it('enforces the configured max steps', () => {
    const config = parsePlanningConfig({ PLANNING_MAX_STEPS: '2' });
    const builder = new ExecutionPlanBuilder({ config });
    const route = makeRouteDecision({ executionMode: ExecutionMode.Sequential });

    expect(() => builder.build(baseInput({ route }))).toThrow(ExecutionPlanLimitError);
  });

  it('enforces a request maxSteps constraint', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({ executionMode: ExecutionMode.Sequential });

    expect(() => builder.build(baseInput({ route, constraints: { maxSteps: 2 } }))).toThrow(
      ExecutionPlanLimitError,
    );
  });
});

describe('maximum depth limit', () => {
  it('enforces the configured max plan depth', () => {
    const config = parsePlanningConfig({ PLANNING_MAX_PLAN_DEPTH: '1' });
    const builder = new ExecutionPlanBuilder({ config });
    const route = makeRouteDecision({ executionMode: ExecutionMode.Sequential });

    expect(() => builder.build(baseInput({ route }))).toThrow(ExecutionPlanLimitError);
  });
});

describe('Sprint 1-4 compatibility', () => {
  it('consumes the Sprint 1 AgentRequest contract', () => {
    const builder = new ExecutionPlanBuilder();
    const request = makeAgentRequest({
      agentId: 'AG-101',
      type: 'route',
      context: { traceId: 't', requestId: 'r', receivedAt: '2026-01-01T00:00:00.000Z' },
    });
    const plan = builder.build(baseInput({ request }));

    expect(plan.requestId).toBe('req-1');
  });

  it('consumes the Sprint 2 IntentResult contract', () => {
    const builder = new ExecutionPlanBuilder();
    const definition = makeIntentDefinition({ id: IntentId.SEARCH_KNOWLEDGE });
    const intent = makeIntentResult(definition);
    const plan = builder.build(baseInput({ intent }));

    expect(plan.intentId).toBe(IntentId.SEARCH_KNOWLEDGE);
  });

  it('consumes the Sprint 3 ContextSnapshot contract', () => {
    const builder = new ExecutionPlanBuilder();
    const plan = builder.build(baseInput());

    expect(plan.statistics.agentCount).toBeGreaterThan(0);
    expect(plan.intentId).toBe(IntentId.CREATE_PROJECT);
  });

  it('consumes the Sprint 4 RouteDecision contract', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({
      executionMode: ExecutionMode.Parallel,
      candidates: [
        makeRouteCandidate(makeAgentConfiguration({ agentId: 'AG-101' })),
        makeRouteCandidate(makeAgentConfiguration({ agentId: 'AG-102' })),
      ],
    });
    const plan = builder.build(baseInput({ route }));

    expect(plan.mode).toBe(ExecutionMode.Parallel);
    expect(plan.steps).toHaveLength(2);
  });

  it('handles a retired agent status through the plan', () => {
    const builder = new ExecutionPlanBuilder();
    const route = makeRouteDecision({
      selectedAgent: {
        agent: makeAgentConfiguration({ agentId: 'AG-202', status: AgentStatus.Retired }),
        score: undefined as never,
        confidence: 0.5,
        strategy: 'capability-match' as never,
        reasons: [],
      },
      candidates: [
        makeRouteCandidate(
          makeAgentConfiguration({ agentId: 'AG-202', status: AgentStatus.Retired }),
          0.5,
        ),
      ],
    });
    const plan = builder.build(baseInput({ route }));

    expect(plan.steps[0]?.agentId).toBe('AG-202');
  });
});
