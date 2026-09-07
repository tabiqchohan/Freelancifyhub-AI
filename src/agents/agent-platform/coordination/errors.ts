/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Typed, bounded errors.
 *
 * Coordination failures are normalized into safe {@link ExecutionError}s before
 * they ever leave the runtime boundary; these typed errors are the internal
 * contracts the coordinator and its subsystems throw. They never carry secrets
 * or stack traces.
 */

export const COORDINATION_ERROR_CODES = {
  COORDINATION_PLAN_INVALID: 'COORDINATION_PLAN_INVALID',
  COORDINATION_CYCLE_DETECTED: 'COORDINATION_CYCLE_DETECTED',
  COORDINATION_AGENT_REJECTED: 'COORDINATION_AGENT_REJECTED',
  COORDINATION_TASK_FAILED: 'COORDINATION_TASK_FAILED',
  COORDINATION_TIMEOUT: 'COORDINATION_TIMEOUT',
  COORDINATION_CANCELLED: 'COORDINATION_CANCELLED',
  COORDINATION_MESSAGE_INVALID: 'COORDINATION_MESSAGE_INVALID',
  COORDINATION_CONFLICT: 'COORDINATION_CONFLICT',
  COORDINATION_LIMIT_EXCEEDED: 'COORDINATION_LIMIT_EXCEEDED',
  COORDINATION_DEADLOCK: 'COORDINATION_DEADLOCK',
  COORDINATION_INVOCATION_FAILED: 'COORDINATION_INVOCATION_FAILED',
  COORDINATION_AGGREGATION_FAILED: 'COORDINATION_AGGREGATION_FAILED',
  COORDINATION_ILLEGAL_STATE: 'COORDINATION_ILLEGAL_STATE',
} as const;

export type CoordinationErrorCode = keyof typeof COORDINATION_ERROR_CODES;

/** Base typed error thrown by the coordination layer. */
export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(
    code: CoordinationErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    retryable = false,
  ) {
    super(message);
    this.name = 'CoordinationError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }

  /** Normalizes this error into the safe, external execution error shape. */
  toExecutionError(): { code: string; message: string; retryable: boolean; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/** The coordination plan is structurally invalid (Sprint 20 §6). */
export class CoordinationPlanInvalidError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_PLAN_INVALID, message, details);
    this.name = 'CoordinationPlanInvalidError';
  }
}

/** The dependency graph contains a cycle (never executed). */
export class CoordinationCycleError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_CYCLE_DETECTED, message, details);
    this.name = 'CoordinationCycleError';
  }
}

/** Agent selection rejected a task's target (lifecycle/capability/tools). */
export class CoordinationAgentRejectedError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_AGENT_REJECTED, message, details);
    this.name = 'CoordinationAgentRejectedError';
  }
}

/** A task terminated unsuccessfully. */
export class CoordinationTaskFailedError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>, retryable = false) {
    super(COORDINATION_ERROR_CODES.COORDINATION_TASK_FAILED, message, details, retryable);
    this.name = 'CoordinationTaskFailedError';
  }
}

/** The coordination exceeded its global deadline. */
export class CoordinationTimeoutError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_TIMEOUT, message, details);
    this.name = 'CoordinationTimeoutError';
  }
}

/** The coordination was cancelled. */
export class CoordinationCancelledError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_CANCELLED, message, details);
    this.name = 'CoordinationCancelledError';
  }
}

/** A coordination message failed validation (Sprint 20 §10). */
export class CoordinationMessageValidationError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_MESSAGE_INVALID, message, details);
    this.name = 'CoordinationMessageValidationError';
  }
}

/** An unresolved conflict was detected (Sprint 20 §14). */
export class CoordinationConflictError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_CONFLICT, message, details);
    this.name = 'CoordinationConflictError';
  }
}

/** A coordination bound (tasks/concurrency) was exceeded (Sprint 20 §18). */
export class CoordinationLimitError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_LIMIT_EXCEEDED, message, details);
    this.name = 'CoordinationLimitError';
  }
}

/** The plan left tasks blocked without a scheduled dependency path. */
export class CoordinationDeadlockError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_DEADLOCK, message, details);
    this.name = 'CoordinationDeadlockError';
  }
}

/** The runtime invocation port failed to drive an agent (Sprint 20 §9). */
export class CoordinationInvocationError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>, retryable = false) {
    super(COORDINATION_ERROR_CODES.COORDINATION_INVOCATION_FAILED, message, details, retryable);
    this.name = 'CoordinationInvocationError';
  }
}

/** The aggregation/conflict layer failed (Sprint 20 §13/§14). */
export class CoordinationAggregationError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_AGGREGATION_FAILED, message, details);
    this.name = 'CoordinationAggregationError';
  }
}

/** A status transition violated the deterministic task state machine (§4). */
export class CoordinationIllegalStateError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(COORDINATION_ERROR_CODES.COORDINATION_ILLEGAL_STATE, message, details);
    this.name = 'CoordinationIllegalStateError';
  }
}
