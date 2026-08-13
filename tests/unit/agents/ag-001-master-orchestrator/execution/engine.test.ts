import { describe, expect, it } from 'vitest';

import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import {
  FakeAgentExecutor,
  StaticExecutorRegistry,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import {
  ExecutionConcurrencyError,
  ExecutionValidationError,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/errors/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionEventType } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import { buildSinglePlan, buildPlanForMode, baseExecutionRequest } from './fixtures.js';

describe('ExecutionEngine - single mode', () => {
  it('executes a single step to completion', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', output: { done: true } });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(baseExecutionRequest(buildSinglePlan()));

    expect(result.state).toBe(ExecutionState.Completed);
    expect(executor.invocationCount).toBe(1);
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]?.status).toBe(ExecutionStatus.Succeeded);
    expect(result.metrics.completedSteps).toBe(1);
  });

  it('emits lifecycle events in a deterministic order', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1' });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'true' }),
    });

    const result = await engine.execute(baseExecutionRequest(buildSinglePlan()));

    const types = result.events.map((event) => event.type);
    expect(types).toContain(ExecutionEventType.ExecutionCreated);
    expect(types).toContain(ExecutionEventType.ExecutionStarted);
    expect(types).toContain(ExecutionEventType.StepStarted);
    expect(types).toContain(ExecutionEventType.StepCompleted);
    expect(types).toContain(ExecutionEventType.ExecutionCompleted);

    const createdIndex = types.indexOf(ExecutionEventType.ExecutionCreated);
    const startedIndex = types.indexOf(ExecutionEventType.ExecutionStarted);
    const stepStartedIndex = types.indexOf(ExecutionEventType.StepStarted);
    const stepCompletedIndex = types.indexOf(ExecutionEventType.StepCompleted);
    const completedIndex = types.indexOf(ExecutionEventType.ExecutionCompleted);
    expect(createdIndex).toBeLessThan(startedIndex);
    expect(startedIndex).toBeLessThan(stepStartedIndex);
    expect(stepStartedIndex).toBeLessThan(stepCompletedIndex);
    expect(stepCompletedIndex).toBeLessThan(completedIndex);
  });

  it('produces metrics with final status and duration', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1' });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildSinglePlan({ requestId: 'req-m-1' })),
    );

    expect(result.metrics.executionId).toBe('exec-1');
    expect(result.metrics.planId).toBe('plan-req-m-1');
    expect(result.metrics.totalSteps).toBe(1);
    expect(result.metrics.finalStatus).toBe(ExecutionState.Completed);
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('ExecutionEngine - sequential mode', () => {
  it('executes steps in dependency order', async () => {
    const order: string[] = [];
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      output: 'ok',
      delayMs: 1,
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const plan = buildPlanForMode(ExecutionMode.Sequential);
    const originalExecute = executor.execute.bind(executor);
    executor.execute = async (request) => {
      order.push(request.stepId);
      return originalExecute(request);
    };

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Completed);
    expect(order).toEqual(['step-1', 'step-2', 'step-3']);
    expect(executor.invocationCount).toBe(3);
  });

  it('records step outputs for propagation', async () => {
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      output: { value: 42 },
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Sequential)),
    );

    const firstOutput = result.stepResults.find((r) => r.stepId === 'step-1')?.output;
    expect(firstOutput).toEqual({ value: 42 });
  });
});

describe('ExecutionEngine - parallel mode', () => {
  it('executes independent steps concurrently', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 5 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Parallel)),
    );

    expect(result.state).toBe(ExecutionState.Completed);
    expect(executor.invocationCount).toBe(3);
    expect(result.metrics.parallelBranches).toBeLessThanOrEqual(
      parseExecutionConfig().EXECUTION_MAX_CONCURRENT_STEPS,
    );
  });
});

describe('ExecutionEngine - validation', () => {
  it('rejects a missing execution id', async () => {
    const engine = new ExecutionEngine();
    const request = baseExecutionRequest(buildSinglePlan());
    await expect(engine.execute({ ...request, executionId: '' })).rejects.toThrow(
      ExecutionValidationError,
    );
  });

  it('rejects a missing plan', async () => {
    const engine = new ExecutionEngine();
    await expect(
      engine.execute({
        executionId: 'exec-x',
        plan: undefined as never,
      }),
    ).rejects.toThrow(ExecutionValidationError);
  });
});

describe('ExecutionEngine - executor failures', () => {
  it('fails the execution when no executor is available', async () => {
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(baseExecutionRequest(buildSinglePlan()));

    expect(result.state).toBe(ExecutionState.Failed);
    expect(result.stepResults[0]?.error?.code).toBe('AGENT_EXECUTOR_UNAVAILABLE');
  });

  it('marks the step failed when the executor returns an error', async () => {
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      succeed: false,
      error: { code: 'AGENT_EXECUTION_FAILED', message: 'boom', retryable: false },
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });
    const plan = buildSinglePlan({
      policy: {
        failureBehavior: FailurePolicy.FailFast,
        retry: { maxRetries: 0, retryable: false },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Failed);
    expect(result.stepResults[0]?.status).toBe(ExecutionStatus.Failed);
    expect(result.stepResults[0]?.error?.code).toBe('AGENT_EXECUTION_FAILED');
  });

  it('throws when an executor rejects', async () => {
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      throwError: { code: 'AGENT_EXECUTION_FAILED', message: 'threw', retryable: false },
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });
    const plan = buildSinglePlan({
      policy: {
        failureBehavior: FailurePolicy.FailFast,
        retry: { maxRetries: 0, retryable: false },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Failed);
    expect(result.stepResults[0]?.error?.code).toBe('AGENT_EXECUTION_FAILED');
  });
});

describe('ExecutionEngine - conditional mode', () => {
  it('executes the primary branch when the condition holds', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1' });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Conditional), {
        inputs: { 'request.input': {}, 'route.confidence': 0.9 },
      }),
    );

    expect(result.state).toBe(ExecutionState.Completed);
    const primary = result.stepResults.find((r) => r.stepId === 'step-1');
    const fallback = result.stepResults.find((r) => r.stepId === 'step-2');
    expect(primary?.status).toBe(ExecutionStatus.Succeeded);
    expect(fallback?.skipped).toBe(true);
  });

  it('executes the fallback branch when the condition is not met', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1' });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Conditional), {
        inputs: { 'request.input': {}, 'route.confidence': 0.1 },
      }),
    );

    expect(result.state).toBe(ExecutionState.Completed);
    const primary = result.stepResults.find((r) => r.stepId === 'step-1');
    const fallback = result.stepResults.find((r) => r.stepId === 'step-2');
    expect(primary?.skipped).toBe(true);
    expect(fallback?.status).toBe(ExecutionStatus.Succeeded);
  });
});

describe('ExecutionEngine - continue on failure', () => {
  it('continues to later steps when the policy allows it', async () => {
    const failing = new FakeAgentExecutor({
      id: 'fail',
      supportedAgents: ['AG-101'],
      succeed: false,
      error: { code: 'X', message: 'nope', retryable: false },
    });
    const succeeding = new FakeAgentExecutor({
      id: 'ok',
      supportedAgents: ['AG-102'],
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([failing, succeeding]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(
      baseExecutionRequest(
        buildPlanForMode(ExecutionMode.Sequential, {
          policy: {
            failureBehavior: FailurePolicy.Continue,
            retry: { maxRetries: 0, retryable: false },
          },
        }),
      ),
    );

    expect(result.state).toBe(ExecutionState.Partial);
    expect(result.stepResults.find((r) => r.stepId === 'step-1')?.status).toBe(
      ExecutionStatus.Failed,
    );
    expect(result.stepResults.find((r) => r.stepId === 'step-2')?.status).toBe(
      ExecutionStatus.Succeeded,
    );
  });
});

describe('ExecutionEngine - duplicate scheduling prevention', () => {
  it('refuses to run the same execution id concurrently', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 30 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const request = baseExecutionRequest(buildSinglePlan());

    const first = engine.execute(request);
    await expect(engine.execute({ ...request, executionId: 'exec-1' })).rejects.toThrow(
      ExecutionConcurrencyError,
    );
    await first;
  });
});
