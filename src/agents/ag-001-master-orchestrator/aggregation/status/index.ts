import { ExecutionStatus } from '../../types/index.js';
import type { ExecutionState } from '../../execution/types/index.js';
import { ExecutionState as ExecutionStateValue } from '../../execution/types/index.js';
import type { AggregationInput, AggregationStatus, NormalizedResult } from '../types/index.js';
import { AggregationStatus as AggregationStatusValue } from '../types/index.js';
import type { StatusCalculator } from '../interfaces/index.js';

/**
 * Deterministic final-status calculation (prompt §9/§33). The execution state
 * already encodes the per-step mix, so the aggregation derives its status from
 * those states, falling back to step-level evidence when needed.
 */
export class DeterministicStatusCalculator implements StatusCalculator {
  readonly name = 'deterministic-status-calculator';

  calculate(results: readonly NormalizedResult[], input: AggregationInput): AggregationStatus {
    const executionStates = input.results.map((execution) => execution.state);

    if (executionStates.some((state) => state === ExecutionStateValue.Cancelled)) {
      return AggregationStatusValue.Cancelled;
    }

    if (executionStates.some((state) => state === ExecutionStateValue.TimedOut)) {
      return AggregationStatusValue.TimedOut;
    }

    if (executionStates.some((state) => state === ExecutionStateValue.Failed)) {
      return AggregationStatusValue.Failed;
    }

    if (executionStates.some((state) => state === ExecutionStateValue.Partial)) {
      return AggregationStatusValue.Partial;
    }

    if (executionStates.some((state) => state === ExecutionStateValue.Completed)) {
      return AggregationStatusValue.Success;
    }

    return this.stepFallback(results);
  }

  /** Step-level fallback when no execution state is decisive (prompt §17/§33). */
  private stepFallback(results: readonly NormalizedResult[]): AggregationStatus {
    if (results.length === 0) {
      return AggregationStatusValue.Success;
    }

    const failed = results.some(
      (result) =>
        result.status === ExecutionStatus.Failed || result.status === ExecutionStatus.TimedOut,
    );
    const succeeded = results.some((result) => result.status === ExecutionStatus.Succeeded);

    if (failed && succeeded) {
      return AggregationStatusValue.Partial;
    }
    if (failed) {
      return AggregationStatusValue.Failed;
    }
    return AggregationStatusValue.Success;
  }
}

/** Maps an existing execution state to the aggregation status vocabulary. */
export function executionStateToAggregationStatus(state: ExecutionState): AggregationStatus {
  switch (state) {
    case ExecutionStateValue.Completed:
      return AggregationStatusValue.Success;
    case ExecutionStateValue.Partial:
      return AggregationStatusValue.Partial;
    case ExecutionStateValue.Failed:
      return AggregationStatusValue.Failed;
    case ExecutionStateValue.Cancelled:
      return AggregationStatusValue.Cancelled;
    case ExecutionStateValue.TimedOut:
      return AggregationStatusValue.TimedOut;
    default:
      return AggregationStatusValue.Success;
  }
}
