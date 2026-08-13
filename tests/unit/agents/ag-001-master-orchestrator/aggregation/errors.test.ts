import { describe, expect, it } from 'vitest';

import {
  AggregationError,
  AggregationValidationError,
  ResultNormalizationError,
  DuplicateResultError,
  ResultLimitError,
  InvalidResultReferenceError,
  AggregationConflictError,
  AggregationConfigError,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/errors/index.js';
import { OrchestratorError } from '../../../../../src/agents/ag-001-master-orchestrator/errors/index.js';

describe('aggregation errors', () => {
  it('provides typed errors with stable codes', () => {
    const cases = [
      [AggregationError, 'AGGREGATION_ERROR'],
      [AggregationValidationError, 'AGGREGATION_VALIDATION_ERROR'],
      [ResultNormalizationError, 'RESULT_NORMALIZATION_ERROR'],
      [DuplicateResultError, 'DUPLICATE_RESULT_ERROR'],
      [ResultLimitError, 'RESULT_LIMIT_ERROR'],
      [InvalidResultReferenceError, 'INVALID_RESULT_REFERENCE_ERROR'],
      [AggregationConflictError, 'AGGREGATION_CONFLICT_ERROR'],
      [AggregationConfigError, 'AGGREGATION_CONFIG_ERROR'],
    ] as const;

    for (const [ErrorClass, code] of cases) {
      const error = new ErrorClass('boom');
      expect(error).toBeInstanceOf(OrchestratorError);
      expect(error).toBeInstanceOf(AggregationError);
      expect(error.code).toBe(code);
      expect(error.message).toBe('boom');
    }
  });

  it('preserves details and retryable flag', () => {
    const error = new DuplicateResultError('duplicate', {
      details: { stepId: 'step-1' },
      retryable: false,
    });
    expect(error.details).toEqual({ stepId: 'step-1' });
    expect(error.retryable).toBe(false);
  });

  it('allows overriding the code', () => {
    const error = new AggregationError('custom', { code: 'CUSTOM_CODE' });
    expect(error.code).toBe('CUSTOM_CODE');
  });
});
