import { describe, expect, it } from 'vitest';

import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import {
  FakeAgentExecutor,
  StaticExecutorRegistry,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import { withTimeout } from '../../../../../src/agents/ag-001-master-orchestrator/execution/timeout/index.js';
import { ExecutionTimeoutError } from '../../../../../src/agents/ag-001-master-orchestrator/execution/errors/index.js';
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
