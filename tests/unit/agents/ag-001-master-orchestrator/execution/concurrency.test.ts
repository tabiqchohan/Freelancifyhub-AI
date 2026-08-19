import { describe, expect, it } from 'vitest';

import { ConcurrencyLimiter } from '../../../../../src/agents/ag-001-master-orchestrator/execution/concurrency/index.js';
import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import {
  StaticExecutorRegistry,
  FakeAgentExecutor,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import type {
  AgentExecutor,
  AgentExecutionRequest,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/interfaces/index.js';
import { ExecutionConfigError } from '../../../../../src/agents/ag-001-master-orchestrator/execution/errors/index.js';
import { buildPlanForMode, baseExecutionRequest } from './fixtures.js';

describe('ConcurrencyLimiter', () => {
  it('bounds the number of concurrently running tasks', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;

    const task = async (id: number): Promise<number> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return id;
    };

    const results = await Promise.all([1, 2, 3, 4, 5].map((id) => limiter.run(() => task(id))));

    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('runs tasks serially when the limit is 1', async () => {
    const limiter = new ConcurrencyLimiter(1);
    let active = 0;
    let peak = 0;

    const task = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    };

    await Promise.all([1, 2, 3].map(() => limiter.run(task)));

    expect(peak).toBe(1);
  });

  it('releases a slot even when a task rejects', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects a non-positive limit', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow(ExecutionConfigError);
    expect(() => new ConcurrencyLimiter(-1)).toThrow(ExecutionConfigError);
  });
});

describe('ExecutionEngine - enforced concurrency (H-4)', () => {
  it('limits concurrent parallel steps to EXECUTION_MAX_CONCURRENT_STEPS', async () => {
    let active = 0;
    let peak = 0;
    const executor: AgentExecutor = {
      id: 'tracking-executor',
      execute: async (request: AgentExecutionRequest) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          success: true,
          output: { stepId: request.stepId },
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 10,
        };
      },
      canExecute: () => true,
      cancel: async () => undefined,
      status: () => ({ available: true }),
    };

    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_MAX_CONCURRENT_STEPS: '2',
      }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Parallel)),
    );

    expect(result.state).toBe(ExecutionState.Completed);
    expect(result.stepResults).toHaveLength(3);
    expect(peak).toBe(2);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('never exceeds the default concurrency ceiling in parallel mode', async () => {
    let active = 0;
    let peak = 0;
    const executor: AgentExecutor = {
      id: 'tracking-executor',
      execute: async (request: AgentExecutionRequest) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
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

    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Parallel)),
    );

    expect(result.state).toBe(ExecutionState.Completed);
    const limit = parseExecutionConfig().EXECUTION_MAX_CONCURRENT_STEPS;
    expect(peak).toBeLessThanOrEqual(limit);
  });

  it('still succeeds all steps when the limit is below the step count', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 2 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_MAX_CONCURRENT_STEPS: '1',
      }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Parallel)),
    );

    expect(result.state).toBe(ExecutionState.Completed);
    expect(result.stepResults).toHaveLength(3);
    expect(result.stepResults.every((step) => step.status === ExecutionStatus.Succeeded)).toBe(
      true,
    );
    expect(executor.invocationCount).toBe(3);
  });
});
