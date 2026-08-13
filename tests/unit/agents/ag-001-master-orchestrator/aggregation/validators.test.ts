import { describe, expect, it } from 'vitest';

import {
  validateAggregationInput,
  validateExecutionResult,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/validators/index.js';
import {
  AggregationValidationError,
  DuplicateResultError,
  InvalidResultReferenceError,
  ResultLimitError,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/errors/index.js';
import { parseAggregationConfig } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/config/index.js';
import type { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import type { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { makeAggregationInput, makeExecutionResult, makeStepResult } from './fixtures.js';

const strictConfig = parseAggregationConfig({});
const looseConfig = parseAggregationConfig({ AGGREGATION_STRICT_VALIDATION: 'false' });

describe('validateExecutionResult', () => {
  it('accepts a well-formed execution result', () => {
    const result = makeExecutionResult();
    expect(() => validateExecutionResult(result)).not.toThrow();
  });

  it('rejects a non-object result', () => {
    expect(() => validateExecutionResult('nope')).toThrow(AggregationValidationError);
  });

  it('rejects a missing executionId', () => {
    const result = makeExecutionResult({ executionId: '' });
    expect(() => validateExecutionResult(result)).toThrow(AggregationValidationError);
  });

  it('rejects an invalid execution state', () => {
    const result = makeExecutionResult({ state: 'BOGUS' as ExecutionState });
    expect(() => validateExecutionResult(result)).toThrow(AggregationValidationError);
  });

  it('rejects a missing stepResults array', () => {
    const result = makeExecutionResult() as unknown as Record<string, unknown>;
    delete result.stepResults;
    expect(() => validateExecutionResult(result)).toThrow(AggregationValidationError);
  });

  it('rejects a step without a valid status', () => {
    const result = makeExecutionResult({
      stepResults: [makeStepResult({ stepId: 'step-1', status: 'BOGUS' as ExecutionStatus })],
    });
    expect(() => validateExecutionResult(result)).toThrow(AggregationValidationError);
  });

  it('rejects duplicate step ids within one result', () => {
    const result = makeExecutionResult({
      stepResults: [
        makeStepResult({ stepId: 'step-1', order: 1 }),
        makeStepResult({ stepId: 'step-1', order: 2 }),
      ],
    });
    expect(() => validateExecutionResult(result)).toThrow(DuplicateResultError);
  });
});

describe('validateAggregationInput', () => {
  it('accepts a well-formed input', () => {
    const input = makeAggregationInput();
    expect(() => validateAggregationInput(input, strictConfig)).not.toThrow();
  });

  it('rejects a non-object input', () => {
    expect(() => validateAggregationInput('nope' as never, strictConfig)).toThrow(
      AggregationValidationError,
    );
  });

  it('rejects a missing executionId', () => {
    const input = makeAggregationInput({ executionId: '' });
    expect(() => validateAggregationInput(input, strictConfig)).toThrow(AggregationValidationError);
  });

  it('rejects a missing plan', () => {
    const input = makeAggregationInput();
    const broken = { ...input, plan: undefined };
    expect(() => validateAggregationInput(broken as never, strictConfig)).toThrow(
      InvalidResultReferenceError,
    );
  });

  it('rejects a missing results array', () => {
    const input = makeAggregationInput();
    const broken = { ...input, results: undefined };
    expect(() => validateAggregationInput(broken as never, strictConfig)).toThrow(
      AggregationValidationError,
    );
  });

  it('rejects empty results under strict validation', () => {
    const input = makeAggregationInput({ results: [] });
    expect(() => validateAggregationInput(input, strictConfig)).toThrow(AggregationValidationError);
  });

  it('allows empty results under loose validation', () => {
    const input = makeAggregationInput({ results: [] });
    expect(() => validateAggregationInput(input, looseConfig)).not.toThrow();
  });

  it('rejects a result count above the configured limit', () => {
    const config = parseAggregationConfig({ AGGREGATION_MAX_RESULT_COUNT: '1' });
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({ executionId: 'exec-1' }),
        makeExecutionResult({ executionId: 'exec-2' }),
      ],
    });
    expect(() => validateAggregationInput(input, config)).toThrow(ResultLimitError);
  });

  it('rejects duplicate execution results', () => {
    const result = makeExecutionResult({ executionId: 'exec-1' });
    const input = makeAggregationInput({ results: [result, { ...result }] });
    expect(() => validateAggregationInput(input, strictConfig)).toThrow(DuplicateResultError);
  });

  it('rejects results referencing a different plan', () => {
    const input = makeAggregationInput({
      results: [makeExecutionResult({ planId: 'other-plan' })],
    });
    expect(() => validateAggregationInput(input, strictConfig)).toThrow(
      InvalidResultReferenceError,
    );
  });
});
