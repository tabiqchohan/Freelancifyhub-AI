/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Deterministic task
 * state machine (Sprint 20 §4).
 *
 * Enforced transitions:
 *
 *   PENDING  ──grant──▶ READY ──start──▶ RUNNING ──complete──▶ COMPLETED
 *      │                  │                ├─fail──────▶ FAILED
 *      │                  │                ├─timed-out─▶ TIMED_OUT
 *      ▼                  ▼                └─cancel────▶ CANCELLED
 *   SKIPPED            (prestart)
 *
 * From PENDING/READY/RUNNING a task may also be cancelled directly. Terminal
 * states (COMPLETED/FAILED/CANCELLED/SKIPPED/TIMED_OUT) are immutable.
 * The machine forbids illegal transitions with explicit reasons.
 */

import { CoordinationIllegalStateError } from './errors.js';
import { isTerminalTaskStatus, TaskStatus } from './types.js';

/** Result of an attempted transition. */
export interface StateTransition {
  readonly taskId: string;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly allowed: boolean;
  readonly reason?: string;
}

/** Validates a status transition without mutating anything (pure). */
export function canTransition(taskId: string, from: TaskStatus, to: TaskStatus): StateTransition {
  if (from === to) {
    return {
      taskId,
      from,
      to,
      allowed: true,
      reason: `task is already ${from}`,
    };
  }
  if (isTerminalTaskStatus(from)) {
    return {
      taskId,
      from,
      to,
      allowed: false,
      reason: `task ${taskId} is terminal (${from}) and cannot move to ${to}`,
    };
  }
  const allowed = TRANSITION_MAP[from]?.includes(to) ?? false;
  return allowed
    ? { taskId, from, to, allowed: true }
    : {
        taskId,
        from,
        to,
        allowed: false,
        reason: `illegal transition ${from} -> ${to} for task ${taskId}`,
      };
}

/** Applies a transition, throwing when the source state already moved. */
export function applyTransition(input: {
  readonly taskId: string;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly taskLabel?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}): StateTransition {
  const transition = canTransition(input.taskId, input.from, input.to);
  if (!transition.allowed) {
    throw new CoordinationIllegalStateError(
      transition.reason ?? `illegal transition for task ${input.taskId}`,
      {
        taskId: input.taskId,
        from: input.from,
        to: input.to,
        ...input.context,
      },
    );
  }
  return transition;
}

/** Grant scheduling eligibility (satisfied required dependencies). */
export function markTaskReady(taskId: string, from: TaskStatus): StateTransition {
  return applyTransition({ taskId, from, to: TaskStatus.Ready });
}

/** Mark a task as started (handed to the executor). */
export function markTaskRunning(taskId: string, from: TaskStatus): StateTransition {
  return applyTransition({ taskId, from, to: TaskStatus.Running });
}

/** Mark a task completed with results. */
export function markTaskCompleted(taskId: string, from: TaskStatus): StateTransition {
  return applyTransition({ taskId, from, to: TaskStatus.Completed });
}

/** Mark a task failed. */
export function markTaskFailed(taskId: string, from: TaskStatus): StateTransition {
  return applyTransition({ taskId, from, to: TaskStatus.Failed });
}

/** Mark a task skipped (dependency failure; never ran). */
export function markTaskSkipped(taskId: string, from: TaskStatus): StateTransition {
  return applyTransition({ taskId, from, to: TaskStatus.Skipped });
}

/** Mark a task cancelled. */
export function markTaskCancelled(taskId: string, from: TaskStatus): StateTransition {
  return applyTransition({ taskId, from, to: TaskStatus.Cancelled });
}

/** Mark a task timed out. */
export function markTaskTimedOut(taskId: string, from: TaskStatus): StateTransition {
  return applyTransition({ taskId, from, to: TaskStatus.TimedOut });
}

const TRANSITION_MAP: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  [TaskStatus.Pending]: [TaskStatus.Ready, TaskStatus.Skipped, TaskStatus.Cancelled],
  [TaskStatus.Ready]: [TaskStatus.Running, TaskStatus.Skipped, TaskStatus.Cancelled],
  [TaskStatus.Running]: [
    TaskStatus.Completed,
    TaskStatus.Failed,
    TaskStatus.Cancelled,
    TaskStatus.TimedOut,
  ],
  [TaskStatus.Completed]: [],
  [TaskStatus.Failed]: [],
  [TaskStatus.Cancelled]: [],
  [TaskStatus.Skipped]: [],
  [TaskStatus.TimedOut]: [],
};
