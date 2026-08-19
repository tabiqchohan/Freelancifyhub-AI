import { describe, expect, it } from 'vitest';

import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import {
  StaticExecutorRegistry,
  FakeAgentExecutor,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import type {
  AgentExecutor,
  AgentExecutionRequest,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/interfaces/index.js';
import { buildPlanForMode, baseExecutionRequest } from './fixtures.js';

function trackingExecutor(track: { active: number; peak: number }): AgentExecutor {
  return {
    id: 'tracking-executor',
    execute: async (request: AgentExecutionRequest) => {
      track.active += 1;
      track.peak = Math.max(track.peak, track.active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      track.active -= 1;
      return {
        success: true,
        output: { stepId: request.stepId },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 5,
      };
    },
    canExecute: () => true,
    cancel: async () => undefined,
    status: () => ({ available: true }),
  };
}

describe('ExecutionEngine - H-7 stress coverage', () => {
  it('retries a failing step while still respecting the concurrency limit', async () => {
    const track = { active: 0, peak: 0 };
    const attempts: Record<string, number> = {};

    const executor: AgentExecutor = {
      ...trackingExecutor(track),
      id: 'retry-tracker',
      execute: async (request: AgentExecutionRequest) => {
        track.active += 1;
        track.peak = Math.max(track.peak, track.active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        track.active -= 1;
        const attempt = (attempts[request.stepId] ?? 0) + 1;
        attempts[request.stepId] = attempt;
        if (request.stepId === 'step-1' && attempt === 1) {
          return {
            success: false,
            error: { code: 'TRANSIENT', message: 'flaky', retryable: true },
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 5,
          };
        }
        return {
          success: true,
          output: { stepId: request.stepId },
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 5,
        };
      },
    };

    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_MAX_CONCURRENT_STEPS: '1',
        EXECUTION_BACKOFF_BASE_MS: '1',
        EXECUTION_BACKOFF_MAX_MS: '2',
        EXECUTION_MAX_RETRY_ATTEMPTS: '3',
      }),
    });

    const result = await engine.execute(
      baseExecutionRequest(
        buildPlanForMode(ExecutionMode.Parallel, {
          policy: { retry: { maxRetries: 2, retryable: true } },
        }),
      ),
    );

    expect(result.state).toBe(ExecutionState.Completed);
    expect(result.metrics.retryCount).toBe(1);
    expect(result.stepResults[0]?.attemptCount).toBe(2);
    expect(track.peak).toBe(1);
  });

  it('cancellation clears in-flight parallel work without deadlock', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 30 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_MAX_CONCURRENT_STEPS: '2',
      }),
    });

    const request = baseExecutionRequest(buildPlanForMode(ExecutionMode.Parallel));
    const promise = engine.execute(request);
    await new Promise((resolve) => setTimeout(resolve, 5));
    engine.cancel(request.executionId as string, 'interrupted');

    const result = await promise;

    expect(result.state).toBe(ExecutionState.Cancelled);
    expect(result.cancellation?.reason).toBe('interrupted');
  });

  it('runs many simultaneous executions with isolated results', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 2 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_MAX_CONCURRENT_STEPS: '2',
      }),
    });

    const executions = Array.from({ length: 8 }, (_, index) =>
      engine.execute(
        baseExecutionRequest(buildPlanForMode(ExecutionMode.Parallel), {
          executionId: `exec-${index}`,
        }),
      ),
    );

    const results = await Promise.all(executions);

    for (const result of results) {
      expect(result.state).toBe(ExecutionState.Completed);
      expect(result.stepResults).toHaveLength(3);
    }
    expect(new Set(results.map((result) => result.executionId)).size).toBe(8);
  });
});
