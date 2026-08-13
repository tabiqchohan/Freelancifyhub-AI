import { ExecutionStatus } from '../../types/index.js';
import type { ExecutionState } from '../types/index.js';
import { ExecutionState as ExecutionStateValue } from '../types/index.js';
import type { ExecutionStepResult } from '../types/index.js';

/** Status for a step that never started (e.g. skipped, cancelled). */
export const NOT_STARTED_STATUS = ExecutionStatus.Cancelled;

/** Maps a step status to the terminal execution-state it implies. */
export function stepStatusToExecutionState(
  results: readonly ExecutionStepResult[],
  fallback: ExecutionState,
): ExecutionState {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;

  for (const result of results) {
    switch (result.status) {
      case ExecutionStatus.Succeeded:
        completed += 1;
        break;
      case ExecutionStatus.Failed:
      case ExecutionStatus.TimedOut:
        failed += 1;
        break;
      case ExecutionStatus.Cancelled:
        cancelled += 1;
        break;
      default:
        break;
    }
  }

  if (failed > 0) {
    return completed > 0 ? ExecutionStateValue.Partial : ExecutionStateValue.Failed;
  }
  if (cancelled > 0 || results.length === 0) {
    return fallback;
  }
  return ExecutionStateValue.Completed;
}
