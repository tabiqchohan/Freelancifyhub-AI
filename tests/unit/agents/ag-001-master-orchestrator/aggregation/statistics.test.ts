import { describe, expect, it } from 'vitest';

import { AggregationStatisticsCalculator } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/statistics/index.js';
import { ExecutionResultNormalizer } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/normalizers/index.js';
import { parseAggregationConfig } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/config/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { makeAggregationInput, makeExecutionResult, makeStepResult } from './fixtures.js';

const calculator = new AggregationStatisticsCalculator();
const normalizer = new ExecutionResultNormalizer(parseAggregationConfig({}));

describe('AggregationStatisticsCalculator', () => {
  it('counts successful steps', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          stepResults: [
            makeStepResult({ stepId: 'step-1', status: ExecutionStatus.Succeeded }),
            makeStepResult({ stepId: 'step-2', status: ExecutionStatus.Succeeded }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    const statistics = calculator.calculate(input, results);
    expect(statistics.totalExecutions).toBe(1);
    expect(statistics.totalSteps).toBe(2);
    expect(statistics.successfulSteps).toBe(2);
    expect(statistics.failedSteps).toBe(0);
  });

  it('counts failures, cancellations and timeouts', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          state: ExecutionState.Partial,
          stepResults: [
            makeStepResult({
              stepId: 'step-1',
              status: ExecutionStatus.Failed,
              error: { code: 'E', message: 'm', retryable: false },
            }),
            makeStepResult({ stepId: 'step-2', status: ExecutionStatus.Cancelled }),
            makeStepResult({ stepId: 'step-3', status: ExecutionStatus.TimedOut }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    const statistics = calculator.calculate(input, results);
    expect(statistics.failedSteps).toBe(1);
    expect(statistics.cancelledSteps).toBe(1);
    expect(statistics.timedOutSteps).toBe(1);
  });

  it('counts skipped steps separately from cancelled', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          stepResults: [
            makeStepResult({ stepId: 'step-1', status: ExecutionStatus.Cancelled, skipped: true }),
            makeStepResult({ stepId: 'step-2', status: ExecutionStatus.Cancelled }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    const statistics = calculator.calculate(input, results);
    expect(statistics.skippedSteps).toBe(1);
    expect(statistics.cancelledSteps).toBe(1);
  });

  it('counts partial steps only for partial executions', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          state: ExecutionState.Partial,
          stepResults: [makeStepResult({ stepId: 'step-1', status: ExecutionStatus.Succeeded })],
        }),
        makeExecutionResult({
          executionId: 'exec-2',
          state: ExecutionState.Completed,
          stepResults: [makeStepResult({ stepId: 'step-2', status: ExecutionStatus.Succeeded })],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    const statistics = calculator.calculate(input, results);
    expect(statistics.partialSteps).toBe(1);
  });

  it('counts retries and attempts', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          state: ExecutionState.Partial,
          stepResults: [
            makeStepResult({ stepId: 'step-1', status: ExecutionStatus.Failed, attemptCount: 3 }),
            makeStepResult({
              stepId: 'step-2',
              status: ExecutionStatus.Succeeded,
              attemptCount: 2,
            }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    const statistics = calculator.calculate(input, results);
    expect(statistics.retryCount).toBe(3);
    expect(statistics.successfulAttempts).toBe(2);
    expect(statistics.failedAttempts).toBe(3);
  });

  it('counts distinct agents and totals durations', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          durationMs: 100,
          stepResults: [
            makeStepResult({
              stepId: 'step-1',
              agentId: 'AG-101',
              status: ExecutionStatus.Succeeded,
            }),
          ],
        }),
        makeExecutionResult({
          executionId: 'exec-2',
          durationMs: 200,
          stepResults: [
            makeStepResult({
              stepId: 'step-2',
              agentId: 'AG-102',
              status: ExecutionStatus.Succeeded,
            }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    const statistics = calculator.calculate(input, results);
    expect(statistics.agentCount).toBe(2);
    expect(statistics.totalDurationMs).toBe(300);
    expect(statistics.parallelBranches).toBe(1);
  });

  it('tracks warnings, errors and duplicates', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          state: ExecutionState.Partial,
          stepResults: [
            makeStepResult({
              stepId: 'step-1',
              status: ExecutionStatus.Failed,
              attemptCount: 2,
              error: { code: 'E', message: 'm', retryable: true },
            }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    const statistics = calculator.calculate(input, results, 3);
    expect(statistics.warningCount).toBe(1);
    expect(statistics.errorCount).toBe(1);
    expect(statistics.duplicateCount).toBe(3);
  });
});
