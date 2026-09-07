/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Shared, per-run
 * coordination state (Sprint 20 §9).
 *
 * A deterministic in-memory store for one coordination run: task statuses,
 * validated task results, detected conflicts, the current phase, cancellation
 * and deadline flags, and terminal outcome capture. The store is the single
 * source of truth the scheduler, collector and aggregator read from.
 */

import type { IsoTimestamp } from '../../ag-001-master-orchestrator/types/index.js';
import { CoordinationIllegalStateError } from './errors.js';
import {
  applyTransition,
  markTaskCancelled,
  markTaskSkipped,
  markTaskTimedOut,
} from './task-state.js';
import {
  CoordinationPhase,
  CoordinationStatus,
  isTerminalTaskStatus,
  TaskStatus,
  type ConflictRecord,
  type CoordinationLimits,
  type CoordinationPlan,
  type TaskResult,
} from './types.js';

/** Snapshot of shared state for a single coordination run. */
export interface CoordinationStateSnapshot {
  readonly coordinationId: string;
  readonly phase: CoordinationPhase;
  readonly status: CoordinationStatus;
  readonly mode: string;
  readonly statusByTaskId: Readonly<Record<string, TaskStatus>>;
  readonly resultByTaskId: Readonly<Record<string, TaskResult>>;
  readonly conflicts: readonly ConflictRecord[];
  readonly pendingCount: number;
  readonly readyCount: number;
  readonly runningCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly cancelledCount: number;
  readonly skippedCount: number;
  readonly timedOutCount: number;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly cancelled?: boolean;
  readonly deadlineReached?: boolean;
}

/** Shared state store for a single coordination run. */
export class CoordinationStateStore {
  readonly coordinationId: string;

  private readonly plan: CoordinationPlan;
  private readonly limits: CoordinationLimits;
  private readonly taskOrder: readonly string[];
  private readonly statuses = new Map<string, TaskStatus>();
  private readonly results = new Map<string, TaskResult>();
  private readonly conflicts: ConflictRecord[] = [];
  private phase: CoordinationPhase;
  private readonly startedAt: IsoTimestamp;
  private completedAt?: IsoTimestamp;
  private cancelled = false;
  private deadlineReached = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(plan: CoordinationPlan, now: IsoTimestamp) {
    this.plan = plan;
    this.coordinationId = plan.coordinationId;
    this.limits = plan.limits;
    this.taskOrder = plan.tasks.map((task) => task.taskId);
    for (const task of plan.tasks) {
      this.statuses.set(task.taskId, TaskStatus.Pending);
    }
    this.phase = CoordinationPhase.Planned;
    this.startedAt = now;
  }

  get phaseOf(): CoordinationPhase {
    return this.phase;
  }

  get limitsOf(): CoordinationLimits {
    return this.limits;
  }

  get planOf(): CoordinationPlan {
    return this.plan;
  }

  get taskIds(): readonly string[] {
    return this.taskOrder;
  }

  statusOf(taskId: string): TaskStatus {
    return this.statuses.get(taskId) ?? TaskStatus.Pending;
  }

  resultOf(taskId: string): TaskResult | undefined {
    return this.results.get(taskId);
  }

  statusByTaskId(): Readonly<Record<string, TaskStatus>> {
    return Object.fromEntries(this.statuses) as Readonly<Record<string, TaskStatus>>;
  }

  resultByTaskId(): Readonly<Record<string, TaskResult>> {
    return Object.fromEntries(this.results) as Readonly<Record<string, TaskResult>>;
  }

  /** Mark the coordination as dispatching. */
  enterDispatching(now: IsoTimestamp): void {
    if (this.phase !== CoordinationPhase.Planned) {
      throw new CoordinationIllegalStateError(`cannot enter DISPATCHING from ${this.phase}`, {
        coordinationId: this.coordinationId,
      });
    }
    void now;
    this.phase = CoordinationPhase.Dispatching;
  }

  /** Grant readiness for a task whose required dependencies are satisfied. */
  grantReady(taskId: string, from: TaskStatus): void {
    applyTransition({ taskId, from, to: TaskStatus.Ready });
    this.statuses.set(taskId, TaskStatus.Ready);
  }

  /** Start a task (handed to the executor). */
  startTask(taskId: string, from: TaskStatus): void {
    applyTransition({ taskId, from, to: TaskStatus.Running });
    this.statuses.set(taskId, TaskStatus.Running);
  }

  /** Store a validated task result (idempotent per task; last wins). */
  recordResult(result: TaskResult, now: IsoTimestamp): void {
    const current = this.statusOf(result.taskId);
    const from = isTerminalTaskStatus(current) ? current : TaskStatus.Running;
    if (result.status === TaskStatus.Completed) {
      applyTransition({ taskId: result.taskId, from, to: TaskStatus.Completed });
      this.statuses.set(result.taskId, TaskStatus.Completed);
    } else if (result.status === TaskStatus.Failed) {
      applyTransition({ taskId: result.taskId, from, to: TaskStatus.Failed });
      this.statuses.set(result.taskId, TaskStatus.Failed);
    } else if (result.status === TaskStatus.TimedOut) {
      applyTransition({ taskId: result.taskId, from, to: TaskStatus.TimedOut });
      this.statuses.set(result.taskId, TaskStatus.TimedOut);
    } else {
      throw new CoordinationIllegalStateError(
        `cannot record result with status ${result.status} for task ${result.taskId}`,
        { taskId: result.taskId, status: result.status },
      );
    }
    this.results.set(result.taskId, result);
    void now;
  }

  /** Skip a task because a required dependency failed (never ran). */
  skipTask(taskId: string, from: TaskStatus = TaskStatus.Pending): void {
    markTaskSkipped(taskId, from);
    this.statuses.set(taskId, TaskStatus.Skipped);
  }

  /** Cancel a task that may still be queued or running. */
  cancelTask(taskId: string, from: TaskStatus): void {
    markTaskCancelled(taskId, from);
    this.statuses.set(taskId, TaskStatus.Cancelled);
  }

  /** Force-cancel (Running → Cancelled) without harmonising statuses. */
  forceCancelTask(taskId: string): void {
    this.statuses.set(taskId, TaskStatus.Cancelled);
  }

  /** Mark a running task as timed out. */
  timeoutTask(taskId: string, from: TaskStatus): void {
    markTaskTimedOut(taskId, from);
    this.statuses.set(taskId, TaskStatus.TimedOut);
  }

  /** Register a detected conflict. */
  submitConflict(conflict: ConflictRecord): void {
    if (
      this.conflicts.some((c) => c.type === conflict.type && sameIds(c.taskIds, conflict.taskIds))
    ) {
      return;
    }
    this.conflicts.push({ ...conflict, resolved: false });
  }

  get conflictsOf(): readonly ConflictRecord[] {
    return this.conflicts;
  }

  markConflictsResolved(resolved: boolean): void {
    for (const conflict of this.conflicts) {
      (conflict as { resolved: boolean }).resolved = resolved;
    }
  }

  markCancelled(now: IsoTimestamp): void {
    this.cancelled = true;
    this.completedAt = now;
    this.phase = CoordinationPhase.Cancelled;
    this.clearTimer();
  }

  markDeadlineReached(now: IsoTimestamp): void {
    this.deadlineReached = true;
    this.completedAt = now;
    this.phase = CoordinationPhase.TimedOut;
    this.clearTimer();
  }

  markComplete(now: IsoTimestamp): void {
    if (this.cancelled || this.deadlineReached) {
      return;
    }
    this.completedAt = now;
    this.phase = CoordinationPhase.Completed;
    this.clearTimer();
  }

  markFailed(now: IsoTimestamp): void {
    this.completedAt = now;
    this.phase = CoordinationPhase.Failed;
    this.clearTimer();
  }

  armDeadline(ms: number, onReached: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(onReached, ms);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  get startedAtOf(): IsoTimestamp {
    return this.startedAt;
  }

  get completedAtOf(): IsoTimestamp | undefined {
    return this.completedAt;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get isDeadlineReached(): boolean {
    return this.deadlineReached;
  }

  readOnlyStatus(): Readonly<Record<string, TaskStatus>> {
    return this.statusByTaskId();
  }

  /** Deterministic aggregate status for the run so far (Sprint 20 §22). */
  status(): CoordinationStatus {
    if (this.cancelled) {
      return CoordinationStatus.Cancelled;
    }
    if (this.deadlineReached) {
      return CoordinationStatus.TimedOut;
    }
    const snapshot = this.snapshot();
    if (snapshot.runningCount > 0) {
      return CoordinationStatus.Running;
    }
    const total = snapshot.pendingCount + snapshot.readyCount;
    if (snapshot.failedCount > 0 && total === 0) {
      return CoordinationStatus.Failed;
    }
    if (total > 0) {
      return CoordinationStatus.Running;
    }
    if (snapshot.failedCount === 0) {
      return CoordinationStatus.Completed;
    }
    return CoordinationStatus.Partial;
  }

  /** Read-only snapshot used for scheduling and event emission. */
  snapshot(): CoordinationStateSnapshot {
    let pending = 0;
    let ready = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let skipped = 0;
    let timedOut = 0;
    for (const status of this.statuses.values()) {
      switch (status) {
        case TaskStatus.Pending:
          pending += 1;
          break;
        case TaskStatus.Ready:
          ready += 1;
          break;
        case TaskStatus.Running:
          running += 1;
          break;
        case TaskStatus.Completed:
          completed += 1;
          break;
        case TaskStatus.Failed:
          failed += 1;
          break;
        case TaskStatus.Cancelled:
          cancelled += 1;
          break;
        case TaskStatus.Skipped:
          skipped += 1;
          break;
        case TaskStatus.TimedOut:
          timedOut += 1;
          break;
      }
    }
    return {
      coordinationId: this.coordinationId,
      phase: this.phase,
      status: this.status(),
      mode: this.plan.mode,
      statusByTaskId: this.statusByTaskId(),
      resultByTaskId: this.resultByTaskId(),
      conflicts: Object.freeze([...this.conflicts]),
      pendingCount: pending,
      readyCount: ready,
      runningCount: running,
      completedCount: completed,
      failedCount: failed,
      cancelledCount: cancelled,
      skippedCount: skipped,
      timedOutCount: timedOut,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      cancelled: this.cancelled,
      deadlineReached: this.deadlineReached,
    };
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
}

/** Convenience: build a fresh store from a validated plan. */
export function createCoordinationState(
  plan: CoordinationPlan,
  now: IsoTimestamp,
): CoordinationStateStore {
  return new CoordinationStateStore(plan, now);
}
