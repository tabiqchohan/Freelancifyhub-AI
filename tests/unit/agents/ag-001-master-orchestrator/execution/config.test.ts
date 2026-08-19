import { describe, expect, it } from 'vitest';

import {
  ExecutionConfigSchema,
  parseExecutionConfig,
  isExecutionFeatureEnabled,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import { ExecutionConfigError } from '../../../../../src/agents/ag-001-master-orchestrator/execution/errors/index.js';
import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import {
  FakeAgentExecutor,
  StaticExecutorRegistry,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { ExecutionConcurrencyError } from '../../../../../src/agents/ag-001-master-orchestrator/execution/errors/index.js';
import { buildPlanForMode, buildSinglePlan, baseExecutionRequest } from './fixtures.js';

describe('execution config', () => {
  it('applies safe defaults', () => {
    const config = parseExecutionConfig({});
    expect(config.EXECUTION_MAX_CONCURRENT_STEPS).toBe(4);
    expect(config.EXECUTION_DEFAULT_TIMEOUT_MS).toBe(10_000);
    expect(config.EXECUTION_MAX_TIMEOUT_MS).toBe(120_000);
    expect(config.EXECUTION_DEFAULT_RETRY_ATTEMPTS).toBe(2);
    expect(config.EXECUTION_MAX_RETRY_ATTEMPTS).toBe(5);
    expect(config.EXECUTION_CANCELLATION_ENABLED).toBe(true);
    expect(config.EXECUTION_EVENTS_ENABLED).toBe(true);
  });

  it('parses overrides from the environment', () => {
    const config = parseExecutionConfig({
      EXECUTION_MAX_CONCURRENT_STEPS: '1',
      EXECUTION_DEFAULT_TIMEOUT_MS: '500',
      EXECUTION_MAX_TIMEOUT_MS: '2500',
      EXECUTION_DEFAULT_RETRY_ATTEMPTS: '1',
      EXECUTION_MAX_RETRY_ATTEMPTS: '2',
      EXECUTION_CANCELLATION_ENABLED: 'false',
      EXECUTION_EVENTS_ENABLED: 'false',
    });

    expect(config.EXECUTION_MAX_CONCURRENT_STEPS).toBe(1);
    expect(config.EXECUTION_DEFAULT_TIMEOUT_MS).toBe(500);
    expect(config.EXECUTION_MAX_TIMEOUT_MS).toBe(2500);
    expect(config.EXECUTION_DEFAULT_RETRY_ATTEMPTS).toBe(1);
    expect(config.EXECUTION_MAX_RETRY_ATTEMPTS).toBe(2);
    expect(config.EXECUTION_CANCELLATION_ENABLED).toBe(false);
    expect(config.EXECUTION_EVENTS_ENABLED).toBe(false);
  });

  it('parses raw strings correctly', () => {
    const result = ExecutionConfigSchema.safeParse({
      EXECUTION_MAX_CONCURRENT_STEPS: 2,
    });
    expect(result.success).toBe(true);
  });

  it('rejects max timeout below default timeout', () => {
    expect(() =>
      parseExecutionConfig({
        EXECUTION_DEFAULT_TIMEOUT_MS: '2000',
        EXECUTION_MAX_TIMEOUT_MS: '1000',
      }),
    ).toThrow(ExecutionConfigError);
  });

  it('rejects max retry below default retry', () => {
    expect(() =>
      parseExecutionConfig({
        EXECUTION_DEFAULT_RETRY_ATTEMPTS: '3',
        EXECUTION_MAX_RETRY_ATTEMPTS: '2',
      }),
    ).toThrow(ExecutionConfigError);
  });

  it('rejects max backoff below base backoff', () => {
    expect(() =>
      parseExecutionConfig({
        EXECUTION_BACKOFF_BASE_MS: '3000',
        EXECUTION_BACKOFF_MAX_MS: '1000',
      }),
    ).toThrow(ExecutionConfigError);
  });

  it('rejects invalid boolean values', () => {
    expect(() => parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'maybe' })).toThrow(
      ExecutionConfigError,
    );
  });
});

describe('isExecutionFeatureEnabled', () => {
  const enabled = parseExecutionConfig({});

  it('enables feature flags by default', () => {
    expect(isExecutionFeatureEnabled(enabled, 'parallel')).toBe(true);
    expect(isExecutionFeatureEnabled(enabled, 'conditional')).toBe(true);
    expect(isExecutionFeatureEnabled(enabled, 'cancellation')).toBe(true);
  });

  it('honours disabled flags', () => {
    const disabled = parseExecutionConfig({ EXECUTION_PARALLEL_ENABLED: 'false' });
    expect(isExecutionFeatureEnabled(disabled, 'parallel')).toBe(false);
  });

  it('treats unknown features as enabled', () => {
    expect(isExecutionFeatureEnabled(enabled, 'nonsense')).toBe(true);
  });
});

describe('ExecutionEngine - H-5 feature flag enforcement', () => {
  it('no-ops cancel() when cancellation is disabled', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 10 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_CANCELLATION_ENABLED: 'false',
      }),
    });

    const resultPromise = engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Sequential)),
    );
    engine.cancel('exec-1', 'must be ignored');
    const result = await resultPromise;

    expect(result.state).toBe(ExecutionState.Completed);
    expect(result.cancellation).toBeUndefined();
  });

  it('allows duplicate scheduling when idempotency is disabled', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 5 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_IDEMPOTENCY_ENABLED: 'false',
      }),
    });
    const request = baseExecutionRequest(buildSinglePlan());

    const first = engine.execute(request);
    const second = engine.execute(request);

    await expect(first).resolves.toMatchObject({ state: ExecutionState.Completed });
    await expect(second).resolves.toMatchObject({ state: ExecutionState.Completed });
  });

  it('rejects duplicate scheduling by default (idempotency on)', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 5 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });
    const request = baseExecutionRequest(buildSinglePlan());

    const first = engine.execute(request);
    await expect(engine.execute(request)).rejects.toBeInstanceOf(ExecutionConcurrencyError);
    await expect(first).resolves.toMatchObject({ state: ExecutionState.Completed });
  });

  it('fails closed when parallel mode is disabled', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1' });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_PARALLEL_ENABLED: 'false',
      }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Parallel)),
    );

    expect(result.state).toBe(ExecutionState.Failed);
    expect(result.error?.code).toBe('UNSUPPORTED_EXECUTION_MODE_ERROR');
  });

  it('fails closed when conditional mode is disabled', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1' });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_CONDITIONAL_ENABLED: 'false',
      }),
    });

    const result = await engine.execute(
      baseExecutionRequest(buildPlanForMode(ExecutionMode.Conditional)),
    );

    expect(result.state).toBe(ExecutionState.Failed);
    expect(result.error?.code).toBe('UNSUPPORTED_EXECUTION_MODE_ERROR');
  });

  it('falls back to EXECUTION_DEFAULT_TIMEOUT_MS when the plan omits a budget', async () => {
    const executor = new FakeAgentExecutor({ id: 'e-1', delayMs: 40 });
    const engine = new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_DEFAULT_TIMEOUT_MS: '5',
        EXECUTION_MAX_TIMEOUT_MS: '10',
      }),
    });
    const plan = buildSinglePlan();
    const planWithoutBudget = {
      ...plan,
      policy: { ...plan.policy, maxTotalExecutionTimeMs: 0 },
    };

    const result = await engine.execute(baseExecutionRequest(planWithoutBudget));

    expect(result.state).toBe(ExecutionState.TimedOut);
    expect(result.timeout?.timeoutMs).toBe(5);
  });
});
