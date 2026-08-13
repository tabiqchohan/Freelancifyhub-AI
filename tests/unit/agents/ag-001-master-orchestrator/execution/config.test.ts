import { describe, expect, it } from 'vitest';

import {
  ExecutionConfigSchema,
  parseExecutionConfig,
  isExecutionFeatureEnabled,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import { ExecutionConfigError } from '../../../../../src/agents/ag-001-master-orchestrator/execution/errors/index.js';

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
