import { describe, expect, it } from 'vitest';

import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import {
  FakeAgentExecutor,
  StaticExecutorRegistry,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import {
  computeRetryDelay,
  effectiveMaxAttempts,
  isRetryable,
  shouldRetry,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/retry/index.js';
import { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import { buildSinglePlan, baseExecutionRequest } from './fixtures.js';

describe('retry helpers', () => {
  it('computes deterministic exponential backoff', () => {
    expect(computeRetryDelay(1, 100, 400)).toBe(100);
    expect(computeRetryDelay(2, 100, 400)).toBe(200);
    expect(computeRetryDelay(3, 100, 400)).toBe(400);
    expect(computeRetryDelay(4, 100, 400)).toBe(400);
  });

  it('respects the maximum delay cap', () => {
    expect(computeRetryDelay(10, 100, 500)).toBe(500);
  });

  it('classifies retryable errors', () => {
    expect(isRetryable({ code: 'X', message: 'm', retryable: true })).toBe(true);
    expect(isRetryable({ code: 'X', message: 'm', retryable: false })).toBe(false);
  });

  it('computes retry eligibility from error and budget', () => {
    const error = { code: 'X', message: 'm', retryable: true };
    expect(shouldRetry(error, 1, 3, true)).toBe(true);
    expect(shouldRetry(error, 3, 3, true)).toBe(false);
    expect(shouldRetry(error, 1, 3, false)).toBe(false);
    expect(shouldRetry(error, 1, 3, true)).toBe(true);
  });

  it('caps effective attempts at the config maximum', () => {
    const config = parseExecutionConfig({ EXECUTION_MAX_RETRY_ATTEMPTS: '3' });
    expect(effectiveMaxAttempts({ maxRetries: 5, retryable: true }, config)).toBe(3);
  });
});

describe('ExecutionEngine - retry behaviour', () => {
  it('retries a retryable failure and succeeds on a later attempt', async () => {
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      succeedAfterAttempts: 2,
      error: { code: 'TRANSIENT', message: 'flaky', retryable: true },
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'true',
        EXECUTION_BACKOFF_BASE_MS: '1',
        EXECUTION_BACKOFF_MAX_MS: '2',
        EXECUTION_MAX_RETRY_ATTEMPTS: '3',
      }),
    });
    const plan = buildSinglePlan({
      policy: {
        failureBehavior: FailurePolicy.Continue,
        retry: { maxRetries: 2, retryable: true },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Completed);
    expect(executor.invocationCount).toBe(2);
    expect(result.metrics.retryCount).toBe(1);
    expect(result.events.some((event) => event.type === 'STEP_RETRYING')).toBe(true);
  });

  it('does not retry a non-retryable error', async () => {
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      succeed: false,
      error: { code: 'PERMANENT', message: 'hard fail', retryable: false },
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });
    const plan = buildSinglePlan({
      policy: {
        failureBehavior: FailurePolicy.FailFast,
        retry: { maxRetries: 5, retryable: false },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Failed);
    expect(executor.invocationCount).toBe(1);
    expect(result.metrics.retryCount).toBe(0);
  });

  it('stops after exhausting the retry limit', async () => {
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      succeed: false,
      error: { code: 'TRANSIENT', message: 'flaky', retryable: true },
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_BACKOFF_BASE_MS: '1',
        EXECUTION_BACKOFF_MAX_MS: '1',
        EXECUTION_MAX_RETRY_ATTEMPTS: '2',
        EXECUTION_EVENTS_ENABLED: 'false',
      }),
    });
    const plan = buildSinglePlan({
      policy: {
        failureBehavior: FailurePolicy.FailFast,
        retry: { maxRetries: 1, retryable: true },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Failed);
    expect(executor.invocationCount).toBe(2);
    expect(result.stepResults[0]?.attemptCount).toBe(2);
  });
});
