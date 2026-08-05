import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  DependencyError,
  OrchestratorError,
  PipelineError,
  TimeoutError,
  ValidationError,
} from '../../../../src/agents/ag-001-master-orchestrator/errors/index.js';

describe('errors', () => {
  it('provides a shared base OrchestratorError contract', () => {
    const error = new PipelineError('boom', { details: { stage: 'input' } });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(OrchestratorError);
    expect(error.name).toBe('PipelineError');
    expect(error.code).toBe('PIPELINE_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ stage: 'input' });
  });

  it.each([
    [ValidationError, 'VALIDATION_ERROR', false, 'ValidationError'],
    [ConfigurationError, 'CONFIGURATION_ERROR', false, 'ConfigurationError'],
    [PipelineError, 'PIPELINE_ERROR', true, 'PipelineError'],
    [DependencyError, 'DEPENDENCY_ERROR', true, 'DependencyError'],
    [TimeoutError, 'TIMEOUT_ERROR', true, 'TimeoutError'],
  ])('%s sets a stable code and name', (Ctor, code, retryable, name) => {
    const error = new Ctor('message');

    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.name).toBe(name);
  });

  it('allows a caller-supplied code override', () => {
    const error = new ValidationError('bad input', { code: 'CUSTOM' });

    expect(error.code).toBe('CUSTOM');
  });

  it('propagates a cause when provided', () => {
    const cause = new Error('underlying');
    const error = new DependencyError('unavailable', { cause });

    expect(error.cause).toBe(cause);
  });
});
