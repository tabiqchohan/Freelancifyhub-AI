import { describe, expect, it } from 'vitest';

import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import {
  FakeAgentExecutor,
  StaticExecutorRegistry,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { CancellationController } from '../../../../../src/agents/ag-001-master-orchestrator/execution/cancellation/index.js';
import { ExecutionCancelledError } from '../../../../../src/agents/ag-001-master-orchestrator/execution/errors/index.js';
import { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import { buildSinglePlan, baseExecutionRequest } from './fixtures.js';

describe('CancellationController', () => {
  it('cancels once and stays cancelled', () => {
    const controller = new CancellationController();
    expect(controller.isCancelled).toBe(false);
    controller.cancel('first');
    expect(controller.isCancelled).toBe(true);
    expect(controller.cancellationReason).toBe('first');
    controller.cancel('second');
    expect(controller.cancellationReason).toBe('first');
  });

  it('notifies waiters on cancellation', async () => {
    const controller = new CancellationController();
    const waiting = controller.waitForCancellation();
    controller.cancel('go');
    await expect(waiting).resolves.toBeUndefined();
  });

  it('throws a structured error when cancelled', () => {
    const controller = new CancellationController();
    controller.cancel('stop');
    expect(() => controller.throwIfCancelled()).toThrow(ExecutionCancelledError);
  });
});

describe('ExecutionEngine - cancellation before execution', () => {
  it('ignores a premature cancel request for an unknown execution', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1' });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'true',
      }),
    });

    const request = baseExecutionRequest(buildSinglePlan());
    engine.cancel(request.executionId as string, 'stopping early');

    const result = await engine.execute(request);

    expect(result.state).toBe(ExecutionState.Completed);
    expect(executor.invocationCount).toBe(1);
  });
});

describe('ExecutionEngine - cancellation during execution', () => {
  it('cancels a running execution through the engine API', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 40 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
      }),
    });

    const request = baseExecutionRequest(buildSinglePlan());
    const promise = engine.execute(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    engine.cancel(request.executionId as string, 'interrupted');

    const result = await promise;

    expect(result.state).toBe(ExecutionState.Cancelled);
    expect(result.cancellation?.reason).toBe('interrupted');
  });

  it('marks unstarted steps cancelled', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 40 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
      }),
    });

    const result = await (async () => {
      const request = baseExecutionRequest(buildSinglePlan());
      const promise = engine.execute(request);
      await new Promise((resolve) => setTimeout(resolve, 5));
      engine.cancel(request.executionId as string, 'stop');
      return promise;
    })();

    expect(result.state).toBe(ExecutionState.Cancelled);
  });

  it('supports repeated cancellation idempotently', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 40 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
      }),
    });

    const request = baseExecutionRequest(buildSinglePlan());
    const promise = engine.execute(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    engine.cancel(request.executionId as string, 'first');
    engine.cancel(request.executionId as string, 'second');

    const result = await promise;

    expect(result.state).toBe(ExecutionState.Cancelled);
    expect(result.cancellation?.reason).toBe('first');
  });
});

describe('ExecutionEngine - failure policy metadata', () => {
  it('records fallback metadata without routing', async () => {
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      succeed: false,
      error: { code: 'X', message: 'fail', retryable: false },
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });
    const plan = buildSinglePlan({
      policy: {
        failureBehavior: FailurePolicy.Fallback,
        retry: { maxRetries: 0, retryable: false },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Failed);
    expect(result.stepResults[0]?.metadata?.['fallbackAllowed']).toBe(true);
    expect(result.stepResults[0]?.metadata?.['fallbackAssigned']).toBe(false);
  });

  it('records escalation metadata', async () => {
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      succeed: false,
      error: { code: 'X', message: 'fail', retryable: false },
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });
    const plan = buildSinglePlan({
      policy: {
        failureBehavior: FailurePolicy.Escalate,
        retry: { maxRetries: 0, retryable: false },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Failed);
    expect(result.stepResults[0]?.metadata?.['escalated']).toBe(true);
  });
});
