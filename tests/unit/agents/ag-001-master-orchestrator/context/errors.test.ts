import { describe, expect, it } from 'vitest';

import {
  ContextBuildError,
  ContextValidationError,
  ContextBudgetError,
  ContextOverflowError,
  ContextNormalizationError,
} from '../../../../../src/agents/ag-001-master-orchestrator/context/errors/index.js';
import { OrchestratorError } from '../../../../../src/agents/ag-001-master-orchestrator/errors/index.js';

describe('context error hierarchy', () => {
  it('is a subclass of OrchestratorError', () => {
    expect(new ContextBuildError('boom')).toBeInstanceOf(OrchestratorError);
    expect(new ContextBuildError('boom')).toBeInstanceOf(Error);
  });

  it('assigns a default code to the base error', () => {
    const error = new ContextBuildError('boom');

    expect(error.code).toBe('ORCHESTRATOR_ERROR');
    expect(error.retryable).toBe(false);
  });

  it('assigns typed codes to subclasses', () => {
    expect(new ContextValidationError('x').code).toBe('CONTEXT_VALIDATION_ERROR');
    expect(new ContextBudgetError('x').code).toBe('CONTEXT_BUDGET_ERROR');
    expect(new ContextOverflowError('x').code).toBe('CONTEXT_OVERFLOW_ERROR');
    expect(new ContextNormalizationError('x').code).toBe('CONTEXT_NORMALIZATION_ERROR');
  });

  it('marks overflow errors as retryable', () => {
    expect(new ContextOverflowError('x').retryable).toBe(true);
  });

  it('carries an optional item id and details', () => {
    const error = new ContextBudgetError('budget', {
      itemId: 'item_1',
      details: { maxTokens: 100 },
      code: 'CUSTOM',
    });

    expect(error.itemId).toBe('item_1');
    expect(error.details).toEqual({ maxTokens: 100 });
    expect(error.code).toBe('CUSTOM');
  });

  it('preserves the subclass name', () => {
    expect(new ContextOverflowError('x').name).toBe('ContextOverflowError');
  });
});
