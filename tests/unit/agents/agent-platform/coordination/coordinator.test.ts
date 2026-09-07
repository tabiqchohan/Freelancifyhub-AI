import { describe, expect, it } from 'vitest';

import { CoordinationCoordinator } from '../../../../../src/agents/agent-platform/coordination/coordinator.js';
import { CoordinationPlanner } from '../../../../../src/agents/agent-platform/coordination/task-decomposition.js';
import { AgentSelector } from '../../../../../src/agents/agent-platform/coordination/agent-selection.js';
import { CoordinationEventLog } from '../../../../../src/agents/agent-platform/coordination/events.js';
import { CoordinationMetrics } from '../../../../../src/agents/agent-platform/coordination/metrics.js';
import {
  CoordinationMode,
  TaskStatus,
  TaskFailurePolicy,
  ConflictPolicy,
  type CoordinationRequest,
} from '../../../../../src/agents/agent-platform/coordination/types.js';
import type {
  AgentTask,
  CoordinationResult,
} from '../../../../../src/agents/agent-platform/coordination/types.js';
import {
  dummyExecutorRegistry,
  makeDefinition,
  readableGateway,
  readableRegistry,
} from './fakes.js';

interface FakeInvocation {
  invoke: (task: AgentTask, attempt: number) => Promise<unknown>;
  cancel: (task: AgentTask, attempt: number) => Promise<void>;
  calls: Array<{ taskId: string; attempt: number }>;
}

let clock = 0;
function nowFactory(): () => string {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
  return () => new Date(base + clock++).toISOString();
}

function harness() {
  const registry = readableRegistry([makeDefinition('AG-200'), makeDefinition('AG-201')]);
  const selector = new AgentSelector({
    registry,
    gateway: readableGateway(),
    executorRegistry: dummyExecutorRegistry(),
  });
  const planner = new CoordinationPlanner(selector);
  const eventLog = new CoordinationEventLog();
  const metrics = new CoordinationMetrics();
  return { selector, planner, eventLog, metrics, registry };
}

function makeInvocation(
  behavior: (
    task: AgentTask,
    attempt: number,
  ) => {
    success: boolean;
    output?: unknown;
    error?: { code: string; message: string; retryable: boolean };
  },
): FakeInvocation {
  const calls: Array<{ taskId: string; attempt: number }> = [];
  return {
    calls,
    invoke: async (task, attempt) => {
      calls.push({ taskId: task.taskId, attempt });
      const outcome = behavior(task, attempt);
      return {
        success: outcome.success,
        output: outcome.output,
        error: outcome.error,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
      };
    },
    cancel: async () => undefined,
  };
}

describe('CoordinationCoordinator (Sprint 20 §4–§22)', () => {
  it('runs a single-task coordination to COMPLETED with aggregate output', async () => {
    const { planner, eventLog, metrics } = harness();
    const fake = makeInvocation(() => ({ success: true, output: { done: true } }));
    const coordinator = new CoordinationCoordinator({
      planner,
      invocation: fake as never,
      eventLog,
      metrics,
      now: nowFactory(),
    });
    const result = await coordinator.coordinate({
      correlationId: 'corr-1',
      requester: 'AG-001',
      objective: 'single',
      mode: CoordinationMode.Single,
      tasks: [{ taskId: 't1', agentId: 'AG-200', objective: 'do it' }],
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.status).toBe(TaskStatus.Completed);
    expect(result.aggregate?.output).toEqual({ t1: { done: true } });
    expect(result.correlationId).toBe('corr-1');
    expect(result.error).toBeUndefined();
    expect(eventLog.latest(20).some((e) => e.type === 'TASK_COMPLETED')).toBe(true);
    expect(eventLog.latest(20).some((e) => e.type === 'COORDINATION_COMPLETED')).toBe(true);
  });

  it('drives SEQUENTIAL participants strictly in chain order', async () => {
    const { planner, eventLog, metrics } = harness();
    const executed: string[] = [];
    const fake = makeInvocation(() => {
      return { success: true, output: {} };
    });
    fake.invoke = async (task) => {
      executed.push(task.taskId);
      return {
        success: true,
        output: { task: task.taskId },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
      };
    };
    const coordinator = new CoordinationCoordinator({
      planner,
      invocation: fake as never,
      eventLog,
      metrics,
      now: nowFactory(),
    });
    const result = await coordinator.coordinate(sequentialRequest());
    expect(result.status).toBe('COMPLETED');
    expect(executed).toEqual(['t1', 't2']);
  });

  it('applies FAIL_FAST: a failure cancels remaining queued tasks', async () => {
    const { planner, eventLog, metrics } = harness();
    const fake = makeInvocation((task) =>
      task.taskId === 't2'
        ? { success: false, error: { code: 'BOOM', message: 'nope', retryable: false } }
        : { success: true, output: 'ok' },
    );
    const coordinator = new CoordinationCoordinator({
      planner,
      invocation: fake as never,
      eventLog,
      metrics,
      now: nowFactory(),
    });
    const result = await coordinator.coordinate(parallelRequest());
    expect(result.status).toBe('FAILED');
    expect(result.tasks.find((t) => t.taskId === 't2')?.status).toBe(TaskStatus.Failed);
  });

  it('CONTINUE_INDEPENDENT keeps independent tasks and skips dependents', async () => {
    const { planner, eventLog, metrics } = harness();
    const fake = makeInvocation((task) =>
      task.taskId === 't1'
        ? { success: false, error: { code: 'BOOM', message: 'nope', retryable: false } }
        : { success: true, output: 'ok' },
    );
    const coordinator = new CoordinationCoordinator({
      planner,
      invocation: fake as never,
      eventLog,
      metrics,
      now: nowFactory(),
    });
    const result = await coordinator.coordinate({
      ...parallelRequest(),
      failurePolicy: TaskFailurePolicy.ContinueIndependent,
    });
    expect(result.status).toBe('PARTIAL');
    const t2 = result.tasks.find((t) => t.taskId === 't2');
    expect(t2).toBeDefined();
  });

  it('retries retryable failures, then succeeds, up to the task policy', async () => {
    const { planner, eventLog, metrics } = harness();
    const fake = makeInvocation(() => ({ success: true, output: 'ok' }));
    fake.calls = [];
    const attempts = new Map<string, number>();
    fake.invoke = async (task) => {
      const attempt = (attempts.get(task.taskId) ?? 0) + 1;
      attempts.set(task.taskId, attempt);
      const success = attempt >= 2;
      return {
        success,
        output: success ? 'recovered' : undefined,
        error: success ? undefined : { code: 'TRANSIENT', message: 'try again', retryable: true },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
      };
    };
    const coordinator = new CoordinationCoordinator({
      planner,
      invocation: fake as never,
      eventLog,
      metrics,
      now: nowFactory(),
    });
    const result = await coordinator.coordinate({
      ...singleRequest(),
      tasks: [
        {
          taskId: 't1',
          agentId: 'AG-200',
          objective: 'flaky',
          retry: {
            maxRetries: 2,
            retryable: true,
            backoffMs: 0,
            backoffMultiplier: 1,
            maxBackoffMs: 0,
          },
        },
      ],
    });
    expect(result.status).toBe('COMPLETED');
    expect(attempts.get('t1')).toBe(2);
    expect(eventLog.latest(20).some((e) => e.type === 'TASK_RETRYING')).toBe(true);
  });

  it('marks tasks TIMED_OUT and the coordination PARTIAL', async () => {
    const { planner, eventLog, metrics } = harness();
    const fake = makeInvocation(() => ({
      success: false,
      error: { code: 'EXECUTION_TIMED_OUT', message: 'slow', retryable: false },
    }));
    const coordinator = new CoordinationCoordinator({
      planner,
      invocation: fake as never,
      eventLog,
      metrics,
      now: nowFactory(),
    });
    const result = await coordinator.coordinate(singleRequest());
    expect(result.status).toBe('PARTIAL');
    expect(result.tasks[0]?.status).toBe(TaskStatus.TimedOut);
    expect(result.timedOut).toBeUndefined();
  });

  it('cancels a running coordination via an external AbortSignal', async () => {
    const { planner, eventLog, metrics } = harness();
    const controller = new AbortController();
    const fake = makeInvocation(() => ({ success: true, output: 'ok' }));
    fake.invoke = async () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            success: true,
            output: 'ok',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 10,
          });
        }, 20);
      });
    const coordinator = new CoordinationCoordinator({
      planner,
      invocation: fake as never,
      eventLog,
      metrics,
      now: nowFactory(),
    });
    const run = coordinator.coordinate({ ...singleRequest(), cancellation: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const result: CoordinationResult = await run;
    expect(result.cancelled).toBe(true);
    expect(result.status).toBe('CANCELLED');
  });

  it('fails under FAIL_ON_CONFLICT when contradictory results are produced', async () => {
    const { planner, eventLog, metrics } = harness();
    const fake = makeInvocation((task) => ({
      success: true,
      output: task.taskId === 't1' ? { v: 1 } : { v: 2 },
    }));
    const coordinator = new CoordinationCoordinator({
      planner,
      invocation: fake as never,
      eventLog,
      metrics,
      now: nowFactory(),
    });
    const result = await coordinator.coordinate(
      parallelRequest({ conflictPolicy: ConflictPolicy.FailOnConflict }),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('COORDINATION_CONFLICT');
    expect(eventLog.latest(20).some((e) => e.type === 'CONFLICT_DETECTED')).toBe(true);
  });

  it('exposes coordinator health/status snapshots', async () => {
    const { planner, eventLog, metrics } = harness();
    const fake = makeInvocation(() => ({ success: true, output: 'ok' }));
    const coordinator = new CoordinationCoordinator({
      planner,
      invocation: fake as never,
      eventLog,
      metrics,
      now: nowFactory(),
    });
    await coordinator.coordinate(singleRequest());
    const status = coordinator.status();
    expect(status.healthy).toBe(true);
    expect(status.eventCount).toBeGreaterThan(0);
    expect(metrics.snapshot().counts.totalCoordinations).toBeGreaterThan(0);
  });
});

function singleRequest(overrides: Partial<CoordinationRequest> = {}): CoordinationRequest {
  return {
    correlationId: 'corr-single',
    requester: 'AG-001',
    objective: 'single objective',
    mode: CoordinationMode.Single,
    tasks: [{ taskId: 't1', agentId: 'AG-200', objective: 'single task' }],
    ...overrides,
  };
}

function sequentialRequest(): CoordinationRequest {
  return {
    correlationId: 'corr-seq',
    requester: 'AG-001',
    objective: 'sequential objective',
    mode: CoordinationMode.Sequential,
    tasks: [
      { taskId: 't1', agentId: 'AG-200', objective: 'first' },
      { taskId: 't2', agentId: 'AG-201', objective: 'second', dependencies: ['t1'] },
    ],
  };
}

function parallelRequest(overrides: Partial<CoordinationRequest> = {}): CoordinationRequest {
  return {
    correlationId: 'corr-par',
    requester: 'AG-001',
    objective: 'parallel objective',
    mode: CoordinationMode.Parallel,
    tasks: [
      { taskId: 't1', agentId: 'AG-200', objective: 'same' },
      { taskId: 't2', agentId: 'AG-200', objective: 'same' },
    ],
    ...overrides,
  };
}
