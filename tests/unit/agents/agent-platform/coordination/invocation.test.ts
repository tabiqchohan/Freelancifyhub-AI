import { describe, expect, it } from 'vitest';

import { RuntimeAgentInvocationAdapter } from '../../../../../src/agents/agent-platform/coordination/invocation.js';
import { CoordinationInvocationError } from '../../../../../src/agents/agent-platform/coordination/errors.js';
import { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import { TaskStatus } from '../../../../../src/agents/agent-platform/coordination/types.js';
import type { AgentTask } from '../../../../../src/agents/agent-platform/coordination/types.js';
import { makeDefinition } from './fakes.js';

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  const definition = makeDefinition('AG-200');
  return {
    taskId: 'task.1',
    agentId: definition.agentId,
    coordinationId: 'coord_1',
    objective: 'objective',
    input: { a: 1 },
    dependencies: [],
    requiredCapabilities: [],
    requiredTools: [],
    priority: 0,
    timeoutMs: 5000,
    retry: {
      maxRetries: 1,
      retryable: true,
      backoffMs: 50,
      backoffMultiplier: 2,
      maxBackoffMs: 2000,
    },
    status: TaskStatus.Pending,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('RuntimeAgentInvocationAdapter (Sprint 20 §9/§12)', () => {
  it('throws a typed error when no executor claims the agent', () => {
    const adapter = new RuntimeAgentInvocationAdapter({
      executorRegistry: { resolve: () => undefined } as never,
    });
    expect(() => adapter.executorFor(task())).toThrow(CoordinationInvocationError);
  });

  it('builds deterministic, bounded execution requests with zero executor retries', () => {
    const adapter = new RuntimeAgentInvocationAdapter({
      executorRegistry: { resolve: () => undefined } as never,
    });
    const request = adapter.buildRequest(task({ taskId: 'task.1' }), 2);
    expect(request.executionId).toMatch(/^exec_coord_coord_1_task_1_attempt2$/);
    expect(request.stepId).toBe('coord:coord_1:task.1');
    expect(request.agentId).toBe('AG-200');
    expect(request.policy.timeoutMs).toBe(5000);
    expect(request.policy.maxSteps).toBe(1);
    expect(request.policy.retry.maxRetries).toBe(0);
    expect(request.policy.failureBehavior).toBe(FailurePolicy.FailFast);
    expect(request.inputs).toEqual({ a: 1 });
  });

  it('normalizes successful and failed executor outcomes', async () => {
    const executor = {
      canExecute: () => true,
      execute: async () => ({
        success: true,
        output: { ok: true },
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1000,
      }),
      cancel: async () => undefined,
    };
    const adapter = new RuntimeAgentInvocationAdapter({
      executorRegistry: { resolve: () => executor } as never,
    });
    const outcome = await adapter.invoke(task(), 1);
    expect(outcome.success).toBe(true);
    expect(outcome.output).toEqual({ ok: true });

    const failing = {
      canExecute: () => true,
      execute: async () => ({
        success: false,
        error: { code: 'TASK_EXECUTION_FAILED', message: 'nope', retryable: true },
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:00.500Z',
        durationMs: 500,
      }),
      cancel: async () => undefined,
    };
    const failingAdapter = new RuntimeAgentInvocationAdapter({
      executorRegistry: { resolve: () => failing } as never,
    });
    const failed = await failingAdapter.invoke(task(), 1);
    expect(failed.success).toBe(false);
    expect(failed.error?.code).toBe('TASK_EXECUTION_FAILED');
  });

  it('normalizes thrown executor errors into safe outcomes', async () => {
    const executor = {
      canExecute: () => true,
      execute: async () => {
        throw new Error('network down');
      },
      cancel: async () => undefined,
    };
    const adapter = new RuntimeAgentInvocationAdapter({
      executorRegistry: { resolve: () => executor } as never,
    });
    const outcome = await adapter.invoke(task(), 1);
    expect(outcome.success).toBe(false);
    expect(outcome.error?.code).toBe('COORDINATION_INVOCATION_FAILED');
  });
});
