import { describe, expect, it } from 'vitest';

import {
  DeterministicStatusCalculator,
  executionStateToAggregationStatus,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/status/index.js';
import { ExecutionResultNormalizer } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/normalizers/index.js';
import { AggregationStatus } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/types/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { parseAggregationConfig } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/config/index.js';
import { makeAggregationInput, makeExecutionResult, makeStepResult } from './fixtures.js';

const calculator = new DeterministicStatusCalculator();
const normalizer = new ExecutionResultNormalizer(parseAggregationConfig({}));

describe('executionStateToAggregationStatus', () => {
  it('maps terminal execution states', () => {
    expect(executionStateToAggregationStatus(ExecutionState.Completed)).toBe(
      AggregationStatus.Success,
    );
    expect(executionStateToAggregationStatus(ExecutionState.Partial)).toBe(
      AggregationStatus.Partial,
    );
    expect(executionStateToAggregationStatus(ExecutionState.Failed)).toBe(AggregationStatus.Failed);
    expect(executionStateToAggregationStatus(ExecutionState.Cancelled)).toBe(
      AggregationStatus.Cancelled,
    );
    expect(executionStateToAggregationStatus(ExecutionState.TimedOut)).toBe(
      AggregationStatus.TimedOut,
    );
  });

  it('defaults non-terminal states to success', () => {
    expect(executionStateToAggregationStatus(ExecutionState.Running)).toBe(
      AggregationStatus.Success,
    );
    expect(executionStateToAggregationStatus(ExecutionState.Pending)).toBe(
      AggregationStatus.Success,
    );
  });
});

describe('DeterministicStatusCalculator', () => {
  it('returns success for a completed execution', () => {
    const input = makeAggregationInput();
    const results = normalizer.normalize(input);
    expect(calculator.calculate(results, input)).toBe(AggregationStatus.Success);
  });

  it('returns cancelled when any execution is cancelled', () => {
    const input = makeAggregationInput({
      results: [makeExecutionResult({ executionId: 'exec-1', state: ExecutionState.Cancelled })],
    });
    expect(calculator.calculate([], input)).toBe(AggregationStatus.Cancelled);
  });

  it('returns timed out when any execution is timed out', () => {
    const input = makeAggregationInput({
      results: [makeExecutionResult({ executionId: 'exec-1', state: ExecutionState.TimedOut })],
    });
    expect(calculator.calculate([], input)).toBe(AggregationStatus.TimedOut);
  });

  it('returns failed when any execution is failed', () => {
    const input = makeAggregationInput({
      results: [makeExecutionResult({ executionId: 'exec-1', state: ExecutionState.Failed })],
    });
    expect(calculator.calculate([], input)).toBe(AggregationStatus.Failed);
  });

  it('returns partial when any execution is partial', () => {
    const input = makeAggregationInput({
      results: [makeExecutionResult({ executionId: 'exec-1', state: ExecutionState.Partial })],
    });
    expect(calculator.calculate([], input)).toBe(AggregationStatus.Partial);
  });

  it('falls back to step evidence when no execution state is decisive', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          state: ExecutionState.Ready,
          stepResults: [
            makeStepResult({
              stepId: 'step-1',
              status: ExecutionStatus.Failed,
              error: { code: 'E', message: 'm', retryable: false },
            }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    expect(calculator.calculate(results, input)).toBe(AggregationStatus.Failed);
  });

  it('returns partial when steps failed and succeeded together', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          state: ExecutionState.Ready,
          stepResults: [
            makeStepResult({ stepId: 'step-1', order: 1, status: ExecutionStatus.Failed }),
            makeStepResult({ stepId: 'step-2', order: 2, status: ExecutionStatus.Succeeded }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    expect(calculator.calculate(results, input)).toBe(AggregationStatus.Partial);
  });

  it('returns success for an empty step fallback', () => {
    const input = makeAggregationInput({
      results: [makeExecutionResult({ executionId: 'exec-1', state: ExecutionState.Ready })],
    });
    expect(calculator.calculate([], input)).toBe(AggregationStatus.Success);
  });
});
