import { describe, expect, it } from 'vitest';

import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import {
  FakeAgentExecutor,
  StaticExecutorRegistry,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import { buildSinglePlan, buildPlanForMode, baseExecutionRequest } from './fixtures.js';

describe('ExecutionEngine - input resolution', () => {
  it('resolves request input into the executor request', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1' });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    await engine.execute(
      baseExecutionRequest(buildSinglePlan(), {
        inputs: { 'request.input': { action: 'create' } },
      }),
    );

    const received = executor.callsSnapshot[0];
    expect(received?.inputs['request.input']).toEqual({ action: 'create' });
  });

  it('fails with a structured error for a missing required reference', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1' });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildSinglePlan(), {
        inputs: {},
      }),
    );

    expect(result.state).toBe(ExecutionState.Failed);
    expect(result.stepResults[0]?.error?.code).toBe('EXECUTION_INPUT_RESOLUTION_ERROR');
  });
});

describe('ExecutionEngine - output propagation', () => {
  it('exposes step outputs to later steps in sequential plans', async () => {
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      output: { produced: true },
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Sequential)),
    );

    const first = result.stepResults.find((r) => r.stepId === 'step-1');
    expect(first?.output).toEqual({ produced: true });
    expect(result.stepResults).toHaveLength(3);
  });
});

describe('ExecutionEngine - state transitions', () => {
  it('produces a valid final state for a successful run', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1' });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const result = await engine.execute(baseExecutionRequest(buildSinglePlan()));

    expect(result.state).toBe(ExecutionState.Completed);
    expect(result.metrics.finalStatus).toBe(ExecutionState.Completed);
  });
});

describe('ExecutionEngine - partial execution', () => {
  it('reports PARTIAL when some steps complete and some fail under continue', async () => {
    const failing = new FakeAgentExecutor({
      id: 'fail',
      supportedAgents: ['AG-101'],
      succeed: false,
      error: { code: 'X', message: 'fail', retryable: false },
    });
    const succeeding = new FakeAgentExecutor({
      id: 'ok',
      supportedAgents: ['AG-102', 'AG-103'],
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([failing, succeeding]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_BACKOFF_BASE_MS: '1',
        EXECUTION_BACKOFF_MAX_MS: '1',
        EXECUTION_DEFAULT_RETRY_ATTEMPTS: '1',
        EXECUTION_MAX_RETRY_ATTEMPTS: '1',
      }),
    });
    const plan = buildPlanForMode(ExecutionMode.Sequential, {
      policy: {
        failureBehavior: FailurePolicy.Continue,
        retry: { maxRetries: 0, retryable: false },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Partial);
    expect(result.metrics.completedSteps + result.metrics.failedSteps).toBe(3);
  });
});

describe('ExecutionEngine - concurrency limit', () => {
  it('never runs more parallel steps than the configured limit', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 10 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_MAX_CONCURRENT_STEPS: '1',
        EXECUTION_EVENTS_ENABLED: 'false',
      }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Parallel)),
    );

    expect(result.state).toBe(ExecutionState.Completed);
    expect(result.metrics.parallelBranches).toBe(1);
  });
});
