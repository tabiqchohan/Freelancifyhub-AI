import { describe, expect, it } from 'vitest';

import { AggregationStatus } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { FakeAgentExecutor } from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import {
  IntentId,
  UserRole,
} from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { RoutingRegistry } from '../../../../../src/agents/ag-001-master-orchestrator/routing/registry/index.js';
import {
  ConfidenceLevel,
  EscalationReason,
  ExecutionMode,
  RoutingStatus,
  RoutingStrategy,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { AgentStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import {
  createTestService,
  makeIntentDefinition,
  makeIntentResult,
  makeRoutableAgent,
  makeRouteDecision,
  planForMode,
  planWithTimeout,
  stubIntentClassifier,
  stubPlanBuilder,
  stubRoutingEngine,
} from './fixtures.js';

const validRequest = { text: 'create project', role: UserRole.Freelancer };

describe('MasterOrchestratorService - integration scenarios', () => {
  it('1. routes a valid request end-to-end through the real engines', async () => {
    const { service, executor } = createTestService();
    const response = await service.execute({
      ...validRequest,
      requestId: 'req-e2e-1',
      traceId: 'trace-e2e-1',
    });

    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.route.status).toBe(RoutingStatus.Success);
    expect(response.route.selectedAgent?.agent.agentId).toBe('AG-101');
    expect(response.plan?.mode).toBe(ExecutionMode.Single);
    expect(response.execution?.state).toBe(ExecutionState.Completed);
    expect(response.aggregated?.outputs).toHaveLength(1);
    expect(executor.invocationCount).toBe(1);
    expect(response.requestId).toBe('req-e2e-1');
    expect(response.traceId).toBe('trace-e2e-1');
  });

  it('2. fails closed for an unknown intent without executing anything', async () => {
    const { service, executor } = createTestService();
    const response = await service.execute({
      text: 'xyzz zorp blarg',
      role: UserRole.Freelancer,
      requestId: 'req-unknown',
      traceId: 'trace-unknown',
    });

    expect(response.status).toBe(AggregationStatus.Failed);
    expect(response.route.status).toBe(RoutingStatus.Escalated);
    expect(response.route.escalation?.reason).toBe(EscalationReason.NoMatch);
    expect(response.execution).toBeUndefined();
    expect(response.aggregated).toBeUndefined();
    expect(executor.invocationCount).toBe(0);
  });

  it('3. fails closed for ambiguous (low confidence) routing', async () => {
    const decision = makeRouteDecision({
      status: RoutingStatus.Escalated,
      strategy: RoutingStrategy.Escalation,
      executionMode: ExecutionMode.Single,
      confidence: 0.5,
      confidenceLevel: ConfidenceLevel.Low,
      selectedAgent: undefined,
      candidates: [],
      escalation: {
        reason: EscalationReason.LowConfidence,
        message: 'Routing confidence below threshold',
        details: { confidence: 0.5, lowThreshold: 0.55 },
      },
    });
    const { service, executor } = createTestService({
      intentClassifier: stubIntentClassifier(makeIntentResult(undefined, 0.5)),
      routingEngine: stubRoutingEngine(decision),
    });

    const response = await service.execute(validRequest);

    expect(response.status).toBe(AggregationStatus.Failed);
    expect(response.route.escalation?.reason).toBe(EscalationReason.LowConfidence);
    expect(response.execution).toBeUndefined();
    expect(executor.invocationCount).toBe(0);
  });

  it('4. wraps routing engine failures as orchestration errors', async () => {
    const { service } = createTestService({
      intentClassifier: stubIntentClassifier(makeIntentResult()),
      routingEngine: {
        name: 'broken-routing',
        version: '1.0.0',
        route: () => {
          throw new Error('routing exploded');
        },
      },
    });

    await expect(service.execute(validRequest)).rejects.toMatchObject({
      name: 'OrchestrationError',
      stage: 'ROUTING',
      code: 'STAGE_ERROR',
    });
  });

  it('5. selects a fallback agent when the primary is unavailable', async () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent(
        {
          agentId: 'AG-101',
          capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
        },
        { available: false, reason: 'down' },
      ),
      makeRoutableAgent({
        agentId: 'AG-900',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
    ]);
    const { service, executor } = createTestService({ registry });

    const response = await service.execute(validRequest);

    expect(response.route.status).toBe(RoutingStatus.Fallback);
    expect(response.route.selectedAgent?.agent.agentId).toBe('AG-900');
    expect(response.status).toBe(AggregationStatus.Success);
    expect(executor.invocationCount).toBe(1);
  });

  it('6. wraps planning failures as orchestration errors', async () => {
    const { service } = createTestService({
      intentClassifier: stubIntentClassifier(makeIntentResult()),
      routingEngine: stubRoutingEngine(makeRouteDecision()),
      planBuilder: {
        name: 'broken-plan',
        version: '1.0.0',
        build: () => {
          throw new Error('plan exploded');
        },
      },
    });

    await expect(service.execute(validRequest)).rejects.toMatchObject({
      name: 'OrchestrationError',
      stage: 'PLANNING',
      code: 'STAGE_ERROR',
    });
  });

  it('7. maps execution failure to FAILED without overwriting the terminal state', async () => {
    const executor = new FakeAgentExecutor({
      succeed: false,
      error: { code: 'BOOM', message: 'failed', retryable: true },
    });
    const { service } = createTestService({ executor });

    const response = await service.execute(validRequest);

    expect(response.execution?.state).toBe(ExecutionState.Failed);
    expect(response.status).toBe(AggregationStatus.Failed);
    expect(response.aggregated?.status).toBe(AggregationStatus.Failed);
  });

  it('8. maps execution timeout to TIMED_OUT', async () => {
    const plan = planWithTimeout(planForMode('single'), 60);
    const executor = new FakeAgentExecutor({ output: { ok: true }, delayMs: 500 });
    const { service } = createTestService({
      planBuilder: stubPlanBuilder(plan),
      executor,
    });

    const response = await service.execute(validRequest);

    expect(response.status).toBe(AggregationStatus.TimedOut);
    expect(response.execution?.state).toBe(ExecutionState.TimedOut);
    expect(response.aggregated?.status).toBe(AggregationStatus.TimedOut);
  });

  it('9. cancellation during parallel execution returns CANCELLED', async () => {
    const executor = new FakeAgentExecutor({ output: { ok: true }, delayMs: 50 });
    const { service } = createTestService({
      planBuilder: stubPlanBuilder(planForMode('parallel')),
      executor,
    });
    const requestId = 'req-cancel-par';
    const promise = service.execute({ ...validRequest, requestId, traceId: 'trace-cp' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    service.cancel(requestId);

    const response = await promise;
    expect(response.status).toBe(AggregationStatus.Cancelled);
    expect(response.execution?.state).toBe(ExecutionState.Cancelled);
  });

  it('9b. cancellation after completion does not corrupt the terminal state', async () => {
    const { service } = createTestService();
    const requestId = 'req-cancel-after';
    const response = await service.execute({ ...validRequest, requestId, traceId: 'trace-ca' });
    service.cancel(requestId);

    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.execution?.state).toBe(ExecutionState.Completed);
  });

  it('10. executes parallel plans across all steps', async () => {
    const executor = new FakeAgentExecutor({ output: { ok: true }, delayMs: 5 });
    const { service } = createTestService({
      planBuilder: stubPlanBuilder(planForMode('parallel')),
      executor,
    });

    const response = await service.execute(validRequest);

    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.execution?.state).toBe(ExecutionState.Completed);
    expect(executor.invocationCount).toBe(3);
  });

  it('11. executes conditional plans and honours their branches', async () => {
    const executor = new FakeAgentExecutor({ output: { ok: true }, delayMs: 2 });
    const { service } = createTestService({
      planBuilder: stubPlanBuilder(planForMode('conditional')),
      executor,
    });

    const response = await service.execute(validRequest);

    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.execution?.state).toBe(ExecutionState.Completed);
    expect(executor.invocationCount).toBeGreaterThan(0);
  });

  it('12. executes hybrid plans mixing modes', async () => {
    const executor = new FakeAgentExecutor({ output: { ok: true }, delayMs: 2 });
    const { service } = createTestService({
      planBuilder: stubPlanBuilder(planForMode('hybrid')),
      executor,
    });

    const response = await service.execute(validRequest);

    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.execution?.state).toBe(ExecutionState.Completed);
  });

  it('13. wraps aggregation failures as orchestration errors', async () => {
    const { service } = createTestService({
      intentClassifier: stubIntentClassifier(makeIntentResult()),
      routingEngine: stubRoutingEngine(makeRouteDecision()),
      aggregationService: {
        aggregate: () => {
          throw new Error('aggregate exploded');
        },
      },
    });

    await expect(service.execute(validRequest)).rejects.toMatchObject({
      name: 'OrchestrationError',
      stage: 'AGGREGATION',
      code: 'STAGE_ERROR',
    });
  });

  it('14. sanitizes sensitive data in aggregated outputs', async () => {
    const executor = new FakeAgentExecutor({
      output: { data: { apiKey: 'sk-123-secret', password: 'hunter2', name: 'ok' } },
    });
    const { service } = createTestService({ executor });

    const response = await service.execute(validRequest);
    const serialized = JSON.stringify(response.aggregated);

    expect(serialized).not.toContain('sk-123-secret');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('password');
  });

  it('15. honours routing constraints such as excluded agents', async () => {
    const { service } = createTestService();

    const response = await service.execute({
      ...validRequest,
      requestId: 'req-constraint',
      traceId: 'trace-constraint',
      routingConstraints: { excludedAgents: ['AG-101'] },
    });

    expect(response.route.selectedAgent?.agent.agentId).not.toBe('AG-101');
    expect(response.status).toBe(AggregationStatus.Success);
  });

  it('16. filters draft/disabled agents from routing', async () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent({
        agentId: 'AG-202',
        status: AgentStatus.Draft,
        capabilities: [{ id: 'profile.optimize', name: 'opt', enabled: true }],
      }),
      makeRoutableAgent({
        agentId: 'AG-900',
        status: AgentStatus.InDevelopment,
        capabilities: [{ id: 'profile.optimize', name: 'opt', enabled: true }],
      }),
    ]);
    const intent = makeIntentResult(
      makeIntentDefinition({
        id: IntentId.OPTIMIZE_PROFILE,
        supportedAgents: ['AG-202'],
      }),
    );
    const { service } = createTestService({
      registry,
      intentClassifier: stubIntentClassifier(intent),
    });

    const response = await service.execute({
      text: 'optimize profile',
      role: UserRole.Freelancer,
      requestId: 'req-draft',
      traceId: 'trace-draft',
    });

    expect(response.route.selectedAgent?.agent.agentId).toBe('AG-900');
    expect(response.status).toBe(AggregationStatus.Success);
  });

  it('17. propagates correlation ids across the entire lifecycle', async () => {
    const { service, events } = createTestService();

    const response = await service.execute({
      ...validRequest,
      requestId: 'req-corr',
      traceId: 'trace-corr',
    });

    expect(response.requestId).toBe('req-corr');
    expect(response.traceId).toBe('trace-corr');
    expect(response.aggregated?.executionId).toBe('exec_req-corr');
    for (const event of events.list()) {
      expect(event.requestId).toBe('req-corr');
      expect(event.traceId).toBe('trace-corr');
    }
  });

  it('18. never converts a terminal execution state', async () => {
    const { service: okService } = createTestService();
    const ok = await okService.execute({
      ...validRequest,
      requestId: 'req-t1',
      traceId: 'trace-t1',
    });
    expect(ok.status).toBe(AggregationStatus.Success);
    expect(ok.aggregated?.status).toBe(AggregationStatus.Success);

    const { service: failedService } = createTestService({
      executor: new FakeAgentExecutor({ succeed: false }),
    });
    const failed = await failedService.execute({
      ...validRequest,
      requestId: 'req-t2',
      traceId: 'trace-t2',
    });
    expect(failed.execution?.state).toBe(ExecutionState.Failed);
    expect(failed.status).toBe(AggregationStatus.Failed);
    expect(failed.aggregated?.status).toBe(AggregationStatus.Failed);
  });

  it('19. handles concurrent requests without cross-talk', async () => {
    const executor = new FakeAgentExecutor({ output: { ok: true }, delayMs: 5 });
    const { service } = createTestService({ executor });

    const inputs = [1, 2, 3].map((i) => ({
      text: 'create project',
      role: UserRole.Freelancer,
      requestId: `req-conc-${i}`,
      traceId: `trace-conc-${i}`,
    }));

    const responses = await Promise.all(inputs.map((input) => service.execute(input)));

    for (const response of responses) {
      expect(response.status).toBe(AggregationStatus.Success);
      expect(response.requestId).toBeTruthy();
    }
    expect(new Set(responses.map((r) => r.requestId)).size).toBe(3);
    expect(responses.map((r) => r.execution?.executionId).sort()).toEqual([
      'exec_req-conc-1',
      'exec_req-conc-2',
      'exec_req-conc-3',
    ]);
  });

  it('20. produces deterministic responses for the same input', async () => {
    const { service } = createTestService();
    const input = { ...validRequest, requestId: 'req-det', traceId: 'trace-det' };

    const first = await service.execute(input);
    const second = await service.execute(input);

    expect(first.status).toBe(second.status);
    expect(first.plan?.planId).toBe(second.plan?.planId);
    expect(first.route.selectedAgent?.agent.agentId).toBe(
      second.route.selectedAgent?.agent.agentId,
    );
    expect(first.aggregated?.outputs).toEqual(second.aggregated?.outputs);
    expect(first.execution?.stepResults.map((s) => s.status)).toEqual(
      second.execution?.stepResults.map((s) => s.status),
    );
  });
});
