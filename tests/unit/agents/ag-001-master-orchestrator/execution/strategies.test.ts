import { describe, expect, it } from 'vitest';

import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import {
  FakeAgentExecutor,
  StaticExecutorRegistry,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import { buildPlanForMode, baseExecutionRequest } from './fixtures.js';

describe('ExecutionEngine - conditional execution', () => {
  it('executes the satisfied branch and skips the unsatisfied one', async () => {
    const executed: string[] = [];
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      succeedAfterAttempts: 1,
    });
    const originalExecute = executor.execute.bind(executor);
    executor.execute = async (request) => {
      executed.push(request.stepId);
      return originalExecute(request);
    };

    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const plan = buildPlanForMode(
      ExecutionMode.Conditional,
      {},
      { executionMode: ExecutionMode.Conditional },
    );
    const result = await engine.execute(
      baseExecutionRequest(plan, {
        inputs: {
          'request.input': {},
          'route.confidence': 0.9,
        },
      }),
    );

    // Branch 1 condition `route.confidence > threshold` evaluates true → step-1 runs.
    expect(executed).toContain('step-1');
    expect(executed).not.toContain('step-2');
    expect(result.state).toBe(ExecutionState.Completed);
  });

  it('executes the else branch when the condition is not met', async () => {
    const executed: string[] = [];
    const executor = new FakeAgentExecutor({
      id: 'e-1',
    });
    const originalExecute = executor.execute.bind(executor);
    executor.execute = async (request) => {
      executed.push(request.stepId);
      return originalExecute(request);
    };

    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const plan = buildPlanForMode(
      ExecutionMode.Conditional,
      {},
      { executionMode: ExecutionMode.Conditional },
    );
    const result = await engine.execute(
      baseExecutionRequest(plan, {
        inputs: {
          'request.input': {},
          'route.confidence': 0.1,
        },
      }),
    );

    expect(executed).not.toContain('step-1');
    expect(executed).toContain('step-2');
    expect(result.state).toBe(ExecutionState.Completed);
  });
});

describe('ExecutionEngine - failure policies', () => {
  it('stops remaining sequential steps on fail-fast', async () => {
    const executed: string[] = [];
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      succeed: false,
      error: { code: 'X', message: 'fail', retryable: false },
    });
    const originalExecute = executor.execute.bind(executor);
    executor.execute = async (request) => {
      executed.push(request.stepId);
      return originalExecute(request);
    };

    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });
    const plan = buildPlanForMode(ExecutionMode.Sequential, {
      policy: {
        failureBehavior: FailurePolicy.FailFast,
        retry: { maxRetries: 0, retryable: false },
      },
    });

    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Failed);
    expect(executed.length).toBeLessThan(3);
  });

  it('continues subsequent steps with continue-on-failure (partial)', async () => {
    const executed: string[] = [];
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      succeed: false,
    });
    const originalExecute = executor.execute.bind(executor);
    executor.execute = async (request) => {
      executed.push(request.stepId);
      return originalExecute(request);
    };

    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
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

    // All steps execute (continue), even though the executor always fails.
    expect(executed.length).toBe(3);
    expect(result.state).toBe(ExecutionState.Failed);
    expect(result.stepResults.every((r) => r.status === ExecutionStatus.Failed)).toBe(true);
  });
});

describe('ExecutionEngine - hybrid execution', () => {
  it('executes a hybrid plan respecting dependencies', async () => {
    const executor = new FakeAgentExecutor({
      id: 'e-1',
      succeedAfterAttempts: 1,
    });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const plan = buildPlanForMode(ExecutionMode.Hybrid);
    const result = await engine.execute(baseExecutionRequest(plan));

    expect(result.state).toBe(ExecutionState.Completed);
    expect(executor.invocationCount).toBe(plan.steps.length);
    expect(result.metrics.parallelBranches).toBeGreaterThanOrEqual(1);
  });
});
