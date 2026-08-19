import { describe, expect, it, vi } from 'vitest';

import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import {
  FakeAgentExecutor,
  StaticExecutorRegistry,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import { ExecutionStateManager } from '../../../../../src/agents/ag-001-master-orchestrator/execution/state/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStateError } from '../../../../../src/agents/ag-001-master-orchestrator/execution/errors/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import {
  withTimeout,
  createDeadline,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/timeout/index.js';
import { ExecutionTimeoutError } from '../../../../../src/agents/ag-001-master-orchestrator/execution/errors/index.js';
import type {
  AgentExecutor,
  AgentExecutionResult,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/interfaces/index.js';
import { buildSinglePlan, baseExecutionRequest } from './fixtures.js';

describe('withTimeout helper', () => {
  it('resolves when the promise finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 100, 'too slow')).resolves.toBe('ok');
  });

  it('rejects with a structured timeout error when the promise is too slow', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 50));
    await expect(withTimeout(slow, 10, 'too slow')).rejects.toBeInstanceOf(ExecutionTimeoutError);
  });

  it('cleans up its timer', async () => {
    const timerCount = process.listenerCount('timeout');
    await withTimeout(Promise.resolve('ok'), 100, 'n/a');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(process.listenerCount('timeout')).toBe(timerCount);
  });
});

describe('ExecutionEngine - step timeout', () => {
  it('marks a step timed out that exceeds its timeout', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 40 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });
    const plan = buildSinglePlan({
      policy: {
        failureBehavior: FailurePolicy.FailFast,
        timeoutMs: 10,
        retry: { maxRetries: 0, retryable: false },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.TimedOut);
    expect(result.stepResults[0]?.status).toBe(ExecutionStatus.TimedOut);
    expect(result.stepResults[0]?.error?.code).toBe('EXECUTION_TIMEOUT_ERROR');
  });
});

describe('ExecutionEngine - overall execution timeout', () => {
  it('fails the execution when the overall timeout is exceeded', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 40 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_DEFAULT_TIMEOUT_MS: '10',
        EXECUTION_MAX_TIMEOUT_MS: '20',
      }),
    });
    const plan = buildSinglePlan({
      policy: {
        failureBehavior: FailurePolicy.FailFast,
        timeoutMs: 10_000,
        retry: { maxRetries: 0, retryable: false },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.TimedOut);
    expect(result.timeout?.timeoutMs).toBe(20);
    expect(result.events.some((event) => event.type === 'EXECUTION_TIMED_OUT')).toBe(true);
  });
});

describe('ExecutionEngine - C-2 authoritative overall deadline', () => {
  it('treats a run as TIMED_OUT when work finishes after the deadline even if work wins the race', async () => {
    vi.useFakeTimers();
    try {
      let release:
        ((value: AgentExecutionResult | PromiseLike<AgentExecutionResult>) => void) | undefined;
      const executor: AgentExecutor = {
        id: 'manual-executor',
        execute: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        canExecute: () => true,
        cancel: async () => undefined,
        status: () => ({ available: true }),
      };

      const engine = new ExecutionEngine({
        registry: new StaticExecutorRegistry([executor]),
        config: parseExecutionConfig({
          EXECUTION_EVENTS_ENABLED: 'false',
          EXECUTION_DEFAULT_TIMEOUT_MS: '10',
          EXECUTION_MAX_TIMEOUT_MS: '20',
        }),
      });
      const plan = buildSinglePlan({
        policy: {
          failureBehavior: FailurePolicy.FailFast,
          timeoutMs: 10_000,
          retry: { maxRetries: 0, retryable: false },
        },
      });

      const startWallTime = Date.now();
      const resultPromise = engine.execute(baseExecutionRequest(plan));

      // Let the engine reach the executor (microtask chain settles before we
      // manipulate the clock), otherwise `release` is not yet assigned.
      await Promise.resolve();

      // Simulate a loaded event loop: the executor's promise resolves first (work wins
      // the Promise.race) but wall-clock time has already passed the overall deadline.
      vi.setSystemTime(startWallTime + 25);
      release?.({
        success: true,
        output: { ok: true },
        startedAt: new Date(startWallTime).toISOString(),
        completedAt: new Date(startWallTime + 25).toISOString(),
        durationMs: 25,
      });

      const result = await resultPromise;

      expect(result.state).toBe(ExecutionState.TimedOut);
      expect(result.timeout?.timeoutMs).toBe(20);
      expect(result.stepResults[0]?.status).toBe(ExecutionStatus.Succeeded);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report COMPLETED after the deadline even when a step resolves later', async () => {
    vi.useFakeTimers();
    try {
      const executor: AgentExecutor = {
        id: 'never-resolving-executor',
        execute: () => new Promise<never>(() => undefined),
        canExecute: () => true,
        cancel: async () => undefined,
        status: () => ({ available: true }),
      };

      const engine = new ExecutionEngine({
        registry: new StaticExecutorRegistry([executor]),
        config: parseExecutionConfig({
          EXECUTION_EVENTS_ENABLED: 'true',
          EXECUTION_DEFAULT_TIMEOUT_MS: '10',
          EXECUTION_MAX_TIMEOUT_MS: '20',
        }),
      });
      const plan = buildSinglePlan({
        policy: {
          failureBehavior: FailurePolicy.FailFast,
          timeoutMs: 10_000,
          retry: { maxRetries: 0, retryable: false },
        },
      });

      const resultPromise = engine.execute(baseExecutionRequest(plan));

      // The overall deadline (20ms) elapses with the step still in flight.
      await vi.advanceTimersByTimeAsync(25);

      const result = await resultPromise;

      expect(result.state).toBe(ExecutionState.TimedOut);
      expect(result.stepResults[0]?.status).toBe(ExecutionStatus.Cancelled);
      expect(result.events.some((event) => event.type === 'EXECUTION_TIMED_OUT')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up the overall deadline timer after a successful run', async () => {
    vi.useFakeTimers();
    try {
      const executor = new FakeAgentExecutor({ id: 'e-1' });
      const engine = new ExecutionEngine({
        registry: new StaticExecutorRegistry([executor]),
        config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
      });

      const resultPromise = engine.execute(baseExecutionRequest(buildSinglePlan()));

      await vi.advanceTimersByTimeAsync(50);

      const result = await resultPromise;

      expect(result.state).toBe(ExecutionState.Completed);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweeps the deadline timer after a timed-out run', async () => {
    vi.useFakeTimers();
    try {
      const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 40 });
      const engine = new ExecutionEngine({
        registry: new StaticExecutorRegistry([executor]),
        config: parseExecutionConfig({
          EXECUTION_DEFAULT_TIMEOUT_MS: '10',
          EXECUTION_MAX_TIMEOUT_MS: '20',
        }),
      });
      const plan = buildSinglePlan({
        policy: {
          failureBehavior: FailurePolicy.FailFast,
          timeoutMs: 10_000,
          retry: { maxRetries: 0, retryable: false },
        },
      });

      const resultPromise = engine.execute(baseExecutionRequest(plan));

      await vi.advanceTimersByTimeAsync(60);

      const result = await resultPromise;

      expect(result.state).toBe(ExecutionState.TimedOut);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createDeadline - timer hygiene', () => {
  it('clears its timer when clear() is invoked before the deadline fires', async () => {
    vi.useFakeTimers();
    try {
      const deadline = createDeadline(50);
      deadline.clear();
      await vi.advanceTimersByTimeAsync(100);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ExecutionStateManager - terminal settlement', () => {
  it('commits the first terminal state and ignores later overwrites', () => {
    const manager = new ExecutionStateManager();
    manager.settle(ExecutionState.Completed);
    expect(manager.isSettled).toBe(true);
    expect(manager.settledState).toBe(ExecutionState.Completed);

    manager.settle(ExecutionState.TimedOut);
    expect(manager.settledState).toBe(ExecutionState.Completed);
  });

  it('rejects settling into a non-terminal state', () => {
    const manager = new ExecutionStateManager();
    expect(() => manager.settle(ExecutionState.Running)).toThrow(ExecutionStateError);
  });
});
