import type { ExecutionError } from '../types/index.js';
import type { ExecutionMetrics, ExecutionProgress } from '../types/index.js';
import type { ExecutionStepResult, ExecutionState } from '../types/index.js';
import type { ExecutionEvent, ExecutionEventType } from '../types/index.js';
import type { IsoTimestamp } from '../../types/index.js';
import { ExecutionStatus } from '../../types/index.js';

/** Execution-local result store (prompt §11). Never persists externally. */
export class ExecutionResultStore {
  private readonly stepResults = new Map<string, ExecutionStepResult>();

  record(stepId: string, result: ExecutionStepResult): void {
    this.stepResults.set(stepId, result);
  }

  get(stepId: string): ExecutionStepResult | undefined {
    return this.stepResults.get(stepId);
  }

  has(stepId: string): boolean {
    return this.stepResults.has(stepId);
  }

  output(stepId: string): unknown {
    return this.stepResults.get(stepId)?.output;
  }

  all(): readonly ExecutionStepResult[] {
    return [...this.stepResults.values()].sort((a, b) => a.order - b.order);
  }

  progress(total: number): ExecutionProgress {
    const values = [...this.stepResults.values()];
    let recorded = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let timedOut = 0;
    let running = 0;

    for (const result of values) {
      recorded += 1;
      switch (result.status) {
        case ExecutionStatus.Running:
          running += 1;
          break;
        case ExecutionStatus.Succeeded:
          completed += 1;
          break;
        case ExecutionStatus.Failed:
          failed += 1;
          break;
        case ExecutionStatus.TimedOut:
          timedOut += 1;
          break;
        case ExecutionStatus.Cancelled:
          cancelled += 1;
          break;
        default:
          break;
      }
    }

    const pending = Math.max(total - recorded - running, 0);

    return { total, pending, running, completed, failed, cancelled, timedOut };
  }

  metrics(
    executionId: string,
    planId: string,
    total: number,
    startTime: IsoTimestamp,
    endTime: IsoTimestamp,
    retryCount: number,
    parallelBranches: number,
    finalStatus: ExecutionState,
  ): ExecutionMetrics {
    const progress = this.progress(total);

    return {
      executionId,
      planId,
      startTime,
      endTime,
      durationMs: Math.max(0, new Date(endTime).getTime() - new Date(startTime).getTime()),
      totalSteps: total,
      completedSteps: progress.completed,
      failedSteps: progress.failed,
      cancelledSteps: progress.cancelled,
      timedOutSteps: progress.timedOut,
      retryCount,
      parallelBranches,
      finalStatus,
    };
  }
}

export type { ExecutionEvent, ExecutionEventType, ExecutionError };
