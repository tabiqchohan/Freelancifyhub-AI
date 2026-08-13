import { ExecutionStatus } from '../../types/index.js';
import { ExecutionState } from '../../execution/types/index.js';
import type { AggregationInput, AggregationStatistics, NormalizedResult } from '../types/index.js';

/**
 * Deterministic statistics calculation (prompt §18/§37). All counters are
 * derived from the normalized results and never from the raw input.
 */
export class AggregationStatisticsCalculator {
  readonly name = 'aggregation-statistics-calculator';

  calculate(
    input: AggregationInput,
    results: readonly NormalizedResult[],
    duplicateCount = 0,
  ): AggregationStatistics {
    let successfulSteps = 0;
    let failedSteps = 0;
    let cancelledSteps = 0;
    let timedOutSteps = 0;
    let skippedSteps = 0;
    let retryCount = 0;
    let successfulAttempts = 0;
    let failedAttempts = 0;
    let errorCount = 0;
    let warningCount = 0;

    const agents = new Set<string>();
    const partialExecutions = input.results.filter(
      (execution) => execution.state === ExecutionState.Partial,
    );
    const partialExecutionIds = new Set(
      partialExecutions.map((execution) => execution.executionId),
    );
    let partialSteps = 0;

    for (const result of results) {
      agents.add(result.agentId);
      warningCount += result.warnings.length;

      if (result.error !== undefined) {
        errorCount += 1;
      }

      if (partialExecutionIds.has(result.executionId)) {
        partialSteps += 1;
      }

      switch (result.status) {
        case ExecutionStatus.Succeeded:
          successfulSteps += 1;
          successfulAttempts += result.attemptCount;
          break;
        case ExecutionStatus.Failed:
          failedSteps += 1;
          failedAttempts += result.attemptCount;
          break;
        case ExecutionStatus.TimedOut:
          timedOutSteps += 1;
          failedAttempts += result.attemptCount;
          break;
        case ExecutionStatus.Cancelled:
          if (result.skipped === true) {
            skippedSteps += 1;
          } else {
            cancelledSteps += 1;
          }
          break;
        default:
          break;
      }

      if (result.attemptCount > 1) {
        retryCount += result.attemptCount - 1;
      }
    }

    const totalDurationMs = input.results.reduce(
      (total, execution) => total + Math.max(0, execution.durationMs),
      0,
    );
    const parallelBranches = input.results.reduce(
      (max, execution) => Math.max(max, execution.metrics?.parallelBranches ?? 1),
      1,
    );

    return {
      totalExecutions: input.results.length,
      totalSteps: results.length,
      successfulSteps,
      failedSteps,
      partialSteps,
      cancelledSteps,
      timedOutSteps,
      skippedSteps,
      retryCount,
      successfulAttempts,
      failedAttempts,
      totalDurationMs,
      agentCount: agents.size,
      warningCount,
      errorCount,
      parallelBranches,
      duplicateCount,
    };
  }
}
