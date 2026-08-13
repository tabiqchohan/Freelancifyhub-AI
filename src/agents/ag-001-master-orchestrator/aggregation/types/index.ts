import type { AgentId, IsoTimestamp, RequestId, TraceId } from '../../types/index.js';
import { ExecutionStatus } from '../../types/index.js';
import type { ExecutionState } from '../../execution/types/index.js';
import type { ExecutionError } from '../../execution/types/index.js';
import type { ExecutionPlan, ExecutionStep, FailurePolicy } from '../../planning/types/index.js';
import type { IntentResult } from '../../intent/index.js';
import type { RouteDecision } from '../../routing/types/index.js';
import type { ContextSnapshot } from '../../context/index.js';
import type { ExecutionResult } from '../../execution/types/index.js';

export { ExecutionStatus };

/**
 * High-level status of an aggregated orchestration response (prompt §9/§33).
 * Reuses the architecture status vocabulary so consumers get stable values.
 */
export enum AggregationStatus {
  Success = 'SUCCESS',
  Partial = 'PARTIAL',
  Failed = 'FAILED',
  Cancelled = 'CANCELLED',
  TimedOut = 'TIMED_OUT',
}

/** Coarse grouping of normalized results (prompt §4/§32). */
export enum ResultGroup {
  Successful = 'SUCCESSFUL',
  Failed = 'FAILED',
  Partial = 'PARTIAL',
  Cancelled = 'CANCELLED',
  TimedOut = 'TIMED_OUT',
  Skipped = 'SKIPPED',
  Pending = 'PENDING',
}

/** Input accepted by the aggregator (prompt §1). */
export interface AggregationInput {
  readonly executionId: string;
  readonly plan: ExecutionPlan;
  readonly results: readonly ExecutionResult[];
  readonly intent?: IntentResult;
  readonly route?: RouteDecision;
  readonly context?: ContextSnapshot;
}

/** A normalized, dependency-ordered result in the internal representation. */
export interface NormalizedResult {
  readonly executionId: string;
  readonly planId: string;
  readonly stepId: string;
  readonly agentId: AgentId;
  readonly order: number;
  readonly status: ExecutionStatus;
  readonly group: ResultGroup;
  readonly output?: unknown;
  readonly error?: ResultError;
  readonly warnings: readonly ResultWarning[];
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly durationMs?: number;
  readonly attemptCount: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly skipped?: boolean;
  /** Stable deduplication key: executionId + stepId. */
  readonly key: string;
}

/** Structured, safe error aggregated from a result (prompt §11/§35). */
export interface ResultError {
  readonly code: string;
  readonly message: string;
  readonly stepId?: string;
  readonly agentId?: AgentId;
  readonly executionId?: string;
  readonly retryable: boolean;
  readonly attempt?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Structured, non-fatal warning aggregated from results (prompt §12/§36). */
export interface ResultWarning {
  readonly code: string;
  readonly message: string;
  readonly stepId?: string;
  readonly agentId?: AgentId;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Aggregated structured output preserving origin (prompt §5/§34). */
export interface AggregatedOutput {
  readonly stepId: string;
  readonly agentId: AgentId;
  readonly executionId: string;
  readonly status: ExecutionStatus;
  readonly output: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Retry history captured for a step (prompt §7/§33). */
export interface RetrySummary {
  readonly stepId: string;
  readonly successfulAttempt?: number;
  readonly failedAttempts: readonly number[];
  readonly finalAttempt: number;
  readonly retryCount: number;
}

/** Deterministic statistics for an aggregation (prompt §18/§37). */
export interface AggregationStatistics {
  readonly totalExecutions: number;
  readonly totalSteps: number;
  readonly successfulSteps: number;
  readonly failedSteps: number;
  readonly partialSteps: number;
  readonly cancelledSteps: number;
  readonly timedOutSteps: number;
  readonly skippedSteps: number;
  readonly retryCount: number;
  readonly successfulAttempts: number;
  readonly failedAttempts: number;
  readonly totalDurationMs: number;
  readonly agentCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
  readonly parallelBranches: number;
  readonly duplicateCount: number;
}

/** Safe, structured metadata attached to an aggregated response (prompt §19). */
export interface ResultMetadata {
  readonly responseId: string;
  readonly executionId: string;
  readonly planId: string;
  readonly agentIds: readonly AgentId[];
  readonly stepIds: readonly string[];
  readonly status: AggregationStatus;
  readonly resultCount: number;
  readonly totalDurationMs: number;
  readonly completedAt: IsoTimestamp;
}

/** Typed aggregation configuration (prompt §20/§38). */
export interface AggregationPolicy {
  readonly deduplicationEnabled: boolean;
  readonly strictValidation: boolean;
  readonly includeRetryHistory: boolean;
  readonly includeWarnings: boolean;
  readonly includeErrors: boolean;
  readonly maximumResultCount: number;
  readonly maximumMetadataSize: number;
}

/** The final, normalized orchestration response (prompt §13/§39). */
export interface AggregatedResponse {
  readonly responseId: string;
  readonly executionId: string;
  readonly planId: string;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly status: AggregationStatus;
  readonly outputs: readonly AggregatedOutput[];
  readonly errors: readonly ResultError[];
  readonly warnings: readonly ResultWarning[];
  readonly statistics: AggregationStatistics;
  readonly metadata: ResultMetadata;
  readonly retries: readonly RetrySummary[];
  readonly completedAt: IsoTimestamp;
}

/** Normalized, dependency-aware ordered results plus their grouping. */
export interface AggregationWorkspace {
  readonly normalized: readonly NormalizedResult[];
  readonly grouped: Readonly<Partial<Record<ResultGroup, readonly NormalizedResult[]>>>;
  readonly order: readonly string[];
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
}

export type {
  AgentId,
  IsoTimestamp,
  RequestId,
  TraceId,
  ExecutionState,
  ExecutionError,
  ExecutionPlan,
  ExecutionStep,
  FailurePolicy,
  IntentResult,
  RouteDecision,
  ContextSnapshot,
  ExecutionResult,
};
