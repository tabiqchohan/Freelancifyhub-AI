import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../../../../../src/agents/ag-001-master-orchestrator/errors/index.js';
import { AggregationStatus } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { UserRole } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { UnsupportedExecutionModeError } from '../../../../../src/agents/ag-001-master-orchestrator/planning/errors/index.js';
import { RoutingValidationError } from '../../../../../src/agents/ag-001-master-orchestrator/routing/errors/index.js';
import {
  MasterOrchestratorService,
  type MasterOrchestratorServiceOptions,
} from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/services/master-orchestrator.service.js';
import { OrchestratorEventType } from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/services/events.js';
import { OrchestratorStage } from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/types/index.js';
import { FakeAgentExecutor } from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import {
  createTestService,
  makeIntentResult,
  makeRouteDecision,
  planForMode,
  planWithTimeout,
  stubAggregationServiceThatThrows,
  stubExecutionEngineThatThrows,
  stubIntentClassifier,
  stubIntentClassifierThatThrows,
  stubPlanBuilderThatThrows,
  stubRoutingEngine,
  stubRoutingEngineThatThrows,
} from './fixtures.js';

const validRequest = { text: 'create project', role: UserRole.Freelancer };

describe('MasterOrchestratorService - construction and DI', () => {
  it('fails closed when a required dependency is missing', () => {
    expect(
      () => new MasterOrchestratorService({} as unknown as MasterOrchestratorServiceOptions),
    ).toThrow(ConfigurationError);
  });

  it('exposes stable contract metadata', () => {
    const { service } = createTestService();
    expect(service.name).toBe('master-orchestrator-service');
    expect(service.version).toBe('1.0.0');
  });

  it('routes through injected engines instead of constructing its own', async () => {
    const { service } = createTestService({
      intentClassifier: stubIntentClassifier(makeIntentResult()),
      routingEngine: stubRoutingEngine(makeRouteDecision()),
    });
    const response = await service.execute(validRequest);
    expect(response.status).toBe(AggregationStatus.Success);
  });
});

describe('MasterOrchestratorService - lifecycle ordering', () => {
  it('emits lifecycle events in deterministic stage order', async () => {
    const { service, events } = createTestService({
      intentClassifier: stubIntentClassifier(makeIntentResult()),
      routingEngine: stubRoutingEngine(makeRouteDecision()),
    });
    await service.execute(validRequest);

    const expectedOrder = [
      OrchestratorEventType.OrchestrationStarted,
      OrchestratorEventType.IntentDetected,
      OrchestratorEventType.ContextBuilt,
      OrchestratorEventType.RoutingCompleted,
      OrchestratorEventType.PlanCreated,
      OrchestratorEventType.ExecutionStarted,
      OrchestratorEventType.ExecutionCompleted,
      OrchestratorEventType.AggregationCompleted,
      OrchestratorEventType.OrchestrationCompleted,
    ];
    expect(events.list().map((event) => event.type)).toEqual(expectedOrder);
  });
});

describe('MasterOrchestratorService - error propagation', () => {
  it('wraps intent classifier failures with stage and original code', async () => {
    const { service } = createTestService({
      intentClassifier: stubIntentClassifierThatThrows(new Error('classify boom')),
    });
    await expect(service.execute(validRequest)).rejects.toMatchObject({
      name: 'OrchestrationError',
      stage: OrchestratorStage.IntentDetection,
      code: 'STAGE_ERROR',
      retryable: false,
    });
  });

  it('preserves routing error codes and the routing stage', async () => {
    const { service } = createTestService({
      routingEngine: stubRoutingEngineThatThrows(new RoutingValidationError('bad route')),
    });
    await expect(service.execute(validRequest)).rejects.toMatchObject({
      name: 'OrchestrationError',
      stage: OrchestratorStage.Routing,
      code: 'ROUTING_VALIDATION_ERROR',
    });
  });

  it('preserves planning error codes and the planning stage', async () => {
    const { service } = createTestService({
      planBuilder: stubPlanBuilderThatThrows(
        new UnsupportedExecutionModeError('mode not supported'),
      ),
    });
    await expect(service.execute(validRequest)).rejects.toMatchObject({
      name: 'OrchestrationError',
      stage: OrchestratorStage.Planning,
      code: 'UNSUPPORTED_EXECUTION_MODE_ERROR',
    });
  });

  it('preserves execution error codes and the execution stage', async () => {
    const { service } = createTestService({
      executionEngine: stubExecutionEngineThatThrows(new Error('exec boom')),
    });
    await expect(service.execute(validRequest)).rejects.toMatchObject({
      name: 'OrchestrationError',
      stage: OrchestratorStage.Execution,
      code: 'STAGE_ERROR',
    });
  });

  it('preserves aggregation error codes and the aggregation stage', async () => {
    const { service } = createTestService({
      aggregationService: stubAggregationServiceThatThrows(new Error('aggregate boom')),
    });
    await expect(service.execute(validRequest)).rejects.toMatchObject({
      name: 'OrchestrationError',
      stage: OrchestratorStage.Aggregation,
      code: 'STAGE_ERROR',
    });
  });

  it('emits an OrchestrationFailed event and removes the active execution on failure', async () => {
    const { service, events } = createTestService({
      executionEngine: stubExecutionEngineThatThrows(new Error('boom')),
    });
    await expect(
      service.execute({ ...validRequest, requestId: 'req-fail' }),
    ).rejects.toBeInstanceOf(Error);
    const failed = events
      .list()
      .filter((e) => e.type === OrchestratorEventType.OrchestrationFailed);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]).toMatchObject({ requestId: 'req-fail', stage: OrchestratorStage.Execution });
  });
});

describe('MasterOrchestratorService - cancellation', () => {
  it('returns CANCELLED without invoking the executor when cancelled before execution', async () => {
    const { service, executor } = createTestService({
      intentClassifier: stubIntentClassifier(makeIntentResult()),
      routingEngine: stubRoutingEngine(makeRouteDecision()),
    });
    const requestId = 'req-cancel-before';
    service.cancel(requestId);

    const response = await service.execute({ ...validRequest, requestId, traceId: 'trace-cb' });

    expect(response.status).toBe(AggregationStatus.Cancelled);
    expect(response.stage).toBe(OrchestratorStage.Execution);
    expect(response.execution).toBeUndefined();
    expect(response.aggregated).toBeUndefined();
    expect(executor.invocationCount).toBe(0);
  });

  it('propagates cancellation to the active execution', async () => {
    const executor = new FakeAgentExecutor({ output: { ok: true }, delayMs: 50 });
    const { service } = createTestService({
      intentClassifier: stubIntentClassifier(makeIntentResult()),
      routingEngine: stubRoutingEngine(makeRouteDecision()),
      executor,
    });
    const requestId = 'req-cancel-during';
    const promise = service.execute({ ...validRequest, requestId, traceId: 'trace-cd' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.cancel(requestId);

    const response = await promise;
    expect(response.status).toBe(AggregationStatus.Cancelled);
    expect(response.execution?.state).toBe(ExecutionState.Cancelled);
  });

  it('is idempotent when called repeatedly for the same request', () => {
    const { service, events } = createTestService();
    service.cancel('req-dup');
    service.cancel('req-dup');
    const cancelled = events
      .list()
      .filter((e) => e.type === OrchestratorEventType.OrchestrationCancelled);
    expect(cancelled).toHaveLength(2);
  });
});

describe('MasterOrchestratorService - timeout', () => {
  it('maps execution timeout to TIMED_OUT and never overwrites it', async () => {
    const plan = planWithTimeout(planForMode('single'), 60);
    const executor = new FakeAgentExecutor({ output: { ok: true }, delayMs: 500 });
    const { service } = createTestService({
      intentClassifier: stubIntentClassifier(makeIntentResult()),
      routingEngine: stubRoutingEngine(makeRouteDecision()),
      planBuilder: { name: 'stub-plan-builder', version: '1.0.0', build: () => plan },
      executor,
    });

    const response = await service.execute({
      ...validRequest,
      requestId: 'req-timeout',
      traceId: 'trace-to',
    });

    expect(response.status).toBe(AggregationStatus.TimedOut);
    expect(response.execution?.state).toBe(ExecutionState.TimedOut);
    expect(response.aggregated?.status).toBe(AggregationStatus.TimedOut);
  });
});

describe('MasterOrchestratorService - terminal state preservation', () => {
  it('keeps a SUCCESS aggregation as SUCCESS', async () => {
    const { service } = createTestService();
    const response = await service.execute(validRequest);
    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.aggregated?.status).toBe(AggregationStatus.Success);
  });

  it('keeps a FAILED execution as FAILED', async () => {
    const executor = new FakeAgentExecutor({ succeed: false });
    const { service } = createTestService({ executor });
    const response = await service.execute(validRequest);
    expect(response.execution?.state).toBe(ExecutionState.Failed);
    expect(response.status).toBe(AggregationStatus.Failed);
    expect(response.aggregated?.status).toBe(AggregationStatus.Failed);
  });
});
