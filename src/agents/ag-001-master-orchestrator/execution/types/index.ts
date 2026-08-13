import type { AgentId, IsoTimestamp, RequestId, TraceId } from '../../types/index.js';
import { ExecutionStatus } from '../../types/index.js';
import type { ExecutionMode } from '../../routing/types/index.js';
import type {
  ExecutionPlan,
  ExecutionReference,
  ExecutionPolicy,
  ExecutionRetryPolicy,
  FailurePolicy,
  ExecutionCondition,
  ExecutionStep,
} from '../../planning/types/index.js';

export { ExecutionStatus };

/** Terminal/transitional lifecycle states of a single execution run (prompt §2). */
export enum ExecutionState {
  /** Request received; run not yet created. */
  Pending = 'PENDING',
  /** Run created; state initialised. */
  Planning = 'PLANNING',
  /** Validated and ready to execute. */
  Ready = 'READY',
  /** At least one step is executing. */
  Running = 'RUNNING',
  /** Execution paused (reserved for future sprints). */
  Paused = 'PAUSED',
  /** All steps completed successfully or skipped. */
  Completed = 'COMPLETED',
  /** Some steps completed, some failed under CONTINUE policy. */
  Partial = 'PARTIAL',
  /** Execution failed and stopped. */
  Failed = 'FAILED',
  /** Execution was cancelled. */
  Cancelled = 'CANCELLED',
  /** Execution exceeded its overall timeout. */
  TimedOut = 'TIMED_OUT',
}

/** Typed execution event types (prompt §16). */
export enum ExecutionEventType {
  ExecutionCreated = 'EXECUTION_CREATED',
  ExecutionStarted = 'EXECUTION_STARTED',
  StepStarted = 'STEP_STARTED',
  StepCompleted = 'STEP_COMPLETED',
  StepFailed = 'STEP_FAILED',
  StepRetrying = 'STEP_RETRYING',
  StepTimedOut = 'STEP_TIMED_OUT',
  StepCancelled = 'STEP_CANCELLED',
  StepSkipped = 'STEP_SKIPPED',
  ExecutionCompleted = 'EXECUTION_COMPLETED',
  ExecutionFailed = 'EXECUTION_FAILED',
  ExecutionCancelled = 'EXECUTION_CANCELLED',
  ExecutionTimedOut = 'EXECUTION_TIMED_OUT',
}

/** Structured, safe error carried on step and execution results (prompt §23). */
export interface ExecutionError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** A request to execute a validated execution plan (prompt §1). */
export interface ExecutionRequest {
  readonly executionId: string;
  readonly plan: ExecutionPlan;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  /** Local, in-memory value store used to resolve plan references (prompt §10). */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/** The execution-local context handed to the engine (prompt §1/§18). */
export interface ExecutionContext {
  readonly executionId: string;
  readonly plan: ExecutionPlan;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly startedAt: IsoTimestamp;
  /** Resolves a declarative reference to an execution-local value. */
  readonly resolve: (reference: ExecutionReference) => unknown | undefined;
}

/** A created, tracked execution run (prompt §4/§18). */
export interface ExecutionRun {
  readonly executionId: string;
  readonly plan: ExecutionPlan;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly createdAt: IsoTimestamp;
  readonly state: ExecutionState;
}

/** Per-step execution state tracked by the state manager (prompt §18). */
export interface ExecutionStepState {
  readonly stepId: string;
  readonly agentId: AgentId;
  readonly status: ExecutionStatus;
  readonly attemptCount: number;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly lastError?: ExecutionError;
}

/** Cancellation metadata recorded when an execution is cancelled (prompt §14). */
export interface ExecutionCancellation {
  readonly executionId: string;
  readonly reason: string;
  readonly requestedAt: IsoTimestamp;
  readonly requestedBy?: string;
}

/** Timeout metadata recorded when an execution/step times out (prompt §13). */
export interface ExecutionTimeout {
  readonly executionId: string;
  readonly stepId?: string;
  readonly timeoutMs: number;
  readonly occurredAt: IsoTimestamp;
}

/** Retry metadata recorded for a retried step attempt (prompt §12). */
export interface ExecutionRetry {
  readonly stepId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly error: ExecutionError;
}

/** Progress counters for an execution (prompt §18/§19). */
export interface ExecutionProgress {
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly timedOut: number;
}

/** Metrics captured for an execution (prompt §19). */
export interface ExecutionMetrics {
  readonly executionId: string;
  readonly planId: string;
  readonly startTime: IsoTimestamp;
  readonly endTime?: IsoTimestamp;
  readonly durationMs: number;
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly failedSteps: number;
  readonly cancelledSteps: number;
  readonly timedOutSteps: number;
  readonly retryCount: number;
  readonly parallelBranches: number;
  readonly finalStatus: ExecutionState;
}

/** A single step execution result (prompt §11). */
export interface ExecutionStepResult {
  readonly stepId: string;
  readonly agentId: AgentId;
  readonly order: number;
  readonly status: ExecutionStatus;
  readonly attemptCount: number;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly durationMs: number;
  readonly output?: unknown;
  readonly error?: ExecutionError;
  readonly skipped?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A single typed, safe execution event (prompt §16/§17). */
export interface ExecutionEvent {
  readonly type: ExecutionEventType;
  readonly executionId: string;
  readonly planId: string;
  readonly stepId?: string;
  readonly agentId?: AgentId;
  readonly attempt?: number;
  readonly occurredAt: IsoTimestamp;
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The final, aggregated execution result (prompt §4/§11). */
export interface ExecutionResult {
  readonly executionId: string;
  readonly planId: string;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly state: ExecutionState;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly durationMs: number;
  readonly stepResults: readonly ExecutionStepResult[];
  readonly events: readonly ExecutionEvent[];
  readonly metrics: ExecutionMetrics;
  readonly cancellation?: ExecutionCancellation;
  readonly timeout?: ExecutionTimeout;
  readonly error?: ExecutionError;
}

export type {
  ExecutionPolicy,
  ExecutionRetryPolicy,
  FailurePolicy,
  ExecutionCondition,
  ExecutionPlan,
  ExecutionMode,
  ExecutionReference,
  ExecutionStep,
  AgentId,
  IsoTimestamp,
  RequestId,
  TraceId,
};
