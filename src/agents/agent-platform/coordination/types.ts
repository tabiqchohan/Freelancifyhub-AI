/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Domain contracts.
 *
 * The coordination layer is generic, deterministic-first, and sits strictly
 * ABOVE the Sprint 19 Agent Platform. It never bypasses AG-001, the platform
 * gateway, lifecycle controls, authorization, AG-002/AG-003/AG-004, or the LLM
 * abstraction. All agent invocations flow through the runtime executor, which
 * enforces the platform execution boundary for managed agents.
 */

import type {
  AgentId,
  IsoTimestamp,
  RequestId,
  TraceId,
} from '../../ag-001-master-orchestrator/types/index.js';
import type { ExecutionError } from '../../ag-001-master-orchestrator/execution/index.js';

export type { AgentId, IsoTimestamp, RequestId, TraceId, ExecutionError };

/** Generic coordination modes (Sprint 20 §5). */
export enum CoordinationMode {
  /** Single participating agent. */
  Single = 'SINGLE',
  /** Agent B waits for Agent A (strict chain). */
  Sequential = 'SEQUENTIAL',
  /** Independent agents execute concurrently. */
  Parallel = 'PARALLEL',
  /** Output from one agent becomes controlled input to another. */
  Pipeline = 'PIPELINE',
  /** Independent results reviewed/aggregated by an evaluator. */
  Debate = 'DEBATE',
  /** Combination of sequential, parallel and dependent tasks. */
  Hybrid = 'HYBRID',
}

/** Deterministic, validated task statuses (Sprint 20 §4). */
export enum TaskStatus {
  Pending = 'PENDING',
  Ready = 'READY',
  Running = 'RUNNING',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
  Cancelled = 'CANCELLED',
  Skipped = 'SKIPPED',
  TimedOut = 'TIMED_OUT',
}

/** Terminal task states (never transition out). */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === TaskStatus.Completed ||
    status === TaskStatus.Failed ||
    status === TaskStatus.Cancelled ||
    status === TaskStatus.Skipped ||
    status === TaskStatus.TimedOut
  );
}

/** Aggregate coordination outcome. */
export enum CoordinationStatus {
  Pending = 'PENDING',
  Running = 'RUNNING',
  Completed = 'COMPLETED',
  Partial = 'PARTIAL',
  Failed = 'FAILED',
  Cancelled = 'CANCELLED',
  TimedOut = 'TIMED_OUT',
}

/** Coordination phase for observability (mirrors the execution stages). */
export enum CoordinationPhase {
  Planned = 'PLANNED',
  Dispatching = 'DISPATCHING',
  Aggregating = 'AGGREGATING',
  Cancelling = 'CANCELLING',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
  Cancelled = 'CANCELLED',
  TimedOut = 'TIMED_OUT',
}

/** Task failure policies (Sprint 20 §15). */
export enum TaskFailurePolicy {
  FailFast = 'FAIL_FAST',
  ContinueIndependent = 'CONTINUE_INDEPENDENT',
  SkipDependents = 'SKIP_DEPENDENTS',
  RequireAll = 'REQUIRE_ALL',
  BestEffort = 'BEST_EFFORT',
}

/** Conflict resolution policies (Sprint 20 §14). */
export enum ConflictPolicy {
  Priority = 'PRIORITY',
  FirstSuccess = 'FIRST_SUCCESS',
  AllResults = 'ALL_RESULTS',
  ReviewRequired = 'REVIEW_REQUIRED',
  FailOnConflict = 'FAIL_ON_CONFLICT',
}

/** Result aggregation strategies (Sprint 20 §13). */
export enum AggregationStrategy {
  Collect = 'COLLECT',
  Merge = 'MERGE',
  BestResult = 'BEST_RESULT',
  Consensus = 'CONSENSUS',
  Review = 'REVIEW',
}

/** Coordination concurrency/scope limits (bounds; resolved defaults applied). */
export interface CoordinationLimits {
  /** Maximum total tasks in a single coordination. */
  readonly maxTasks: number;
  /** Maximum concurrent running tasks. */
  readonly maxConcurrentTasks: number;
  /** Maximum concurrently running tasks for a single agent. */
  readonly maxTasksPerAgent: number;
  /** Whole-coordination deadline in milliseconds. */
  readonly globalTimeoutMs: number;
  /** Default per-task deadline in milliseconds. */
  readonly defaultTaskTimeoutMs: number;
  /** Maximum serialized coordination message size in bytes. */
  readonly maxMessageBytes: number;
}

/** Partial limits accepted during validation (defaults applied). */
export type CoordinationLimitsInput = Partial<CoordinationLimits>;

/** Bounded task retry policy (Sprint 20 §16). */
export interface TaskRetryPolicy {
  readonly maxRetries: number;
  readonly retryable: boolean;
  readonly backoffMs: number;
  readonly backoffMultiplier: number;
  readonly maxBackoffMs: number;
}

/** Context reference built externally (AG-001) — never resolved here. */
export interface CoordinationContextReference {
  readonly id: string;
  readonly optional?: boolean;
}

/** A structured, bounded invocation of a participating agent (Sprint 20 §12). */
export interface TaskInvocation {
  readonly taskId: string;
  readonly agentId: AgentId;
  readonly objective: string;
  /** Structured, validated input. Pinned from the plan — never model output. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Agent ids/task ids this task depends on (required by default). */
  readonly dependencies: readonly string[];
  /** Capability ids the task requires the agent to declare (enabled). */
  readonly requiredCapabilities: readonly string[];
  /** Tool names the task requires; must be within the agent's allowlist. */
  readonly requiredTools: readonly string[];
  /** Higher priority runs first. Deterministic tie-break: task order. */
  readonly priority: number;
  readonly timeoutMs: number;
  readonly retry: TaskRetryPolicy;
}

/** A fully-typed coordination task as stored in the plan (Sprint 20 §4). */
export interface AgentTask extends TaskInvocation {
  readonly coordinationId: string;
  readonly status: TaskStatus;
  readonly createdAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
}

/** Input accepted when building a plan (pre-built tasks from AG-001). */
export interface CoordinationTaskInput {
  readonly taskId: string;
  readonly agentId: AgentId;
  readonly objective: string;
  readonly input?: unknown;
  readonly dependencies?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly requiredTools?: readonly string[];
  readonly priority?: number;
  readonly timeoutMs?: number;
  readonly retry?: TaskRetryPolicy;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** An explicit task dependency edge (required by default). */
export interface TaskDependency {
  readonly taskId: string;
  readonly dependsOn: string;
  readonly required: boolean;
}

/** A validated coordination plan (deterministic; invalid graphs fail early). */
export interface CoordinationPlan {
  readonly coordinationId: string;
  readonly mode: CoordinationMode;
  readonly tasks: readonly AgentTask[];
  readonly dependencies: readonly TaskDependency[];
  readonly limits: CoordinationLimits;
  readonly failurePolicy: TaskFailurePolicy;
  readonly conflictPolicy: ConflictPolicy;
  readonly aggregation: AggregationStrategy;
  readonly createdAt: IsoTimestamp;
}

/** The coordination request received by the coordinator (Sprint 20 §4). */
export interface CoordinationRequest {
  /** Server-generated when absent. */
  readonly coordinationId?: string;
  readonly correlationId: string;
  /** The AG-001 execution this coordination belongs to. */
  readonly parentExecutionId?: string;
  /** Safe requester identifier (e.g. `AG-001`, `runtime`). */
  readonly requester: string;
  readonly objective: string;
  /** Reference to request-level context (never the raw payload). */
  readonly contextReference?: string;
  /** Pre-built tasks from AG-001 (deterministic; preferred path). */
  readonly tasks?: readonly CoordinationTaskInput[];
  /** Auto-decomposed participants when no explicit tasks are provided. */
  readonly participatingAgents?: readonly AgentId[];
  readonly mode: CoordinationMode;
  readonly limits?: CoordinationLimitsInput;
  readonly deadline?: number;
  readonly failurePolicy?: TaskFailurePolicy;
  readonly conflictPolicy?: ConflictPolicy;
  readonly aggregation?: AggregationStrategy;
  /** External cancellation (e.g. from the HTTP request / executor). */
  readonly cancellation?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Timing captured for a coordinated result (Sprint 20 §12). */
export interface TaskResultTiming {
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly durationMs: number;
}

/** Token usage when the underlying execution reported it. */
export interface CoordinationTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/** Tool-call usage when the underlying execution reported it. */
export interface CoordinationToolUsage {
  readonly calls?: number;
  readonly successes?: number;
  readonly failures?: number;
}

/** A structured result for a coordinated task (Sprint 20 §12). */
export interface TaskResult {
  readonly taskId: string;
  readonly agentId: AgentId;
  readonly status: TaskStatus;
  readonly output?: unknown;
  readonly errors: readonly ExecutionError[];
  readonly timing: TaskResultTiming;
  readonly tokenUsage?: CoordinationTokenUsage;
  readonly toolUsage?: CoordinationToolUsage;
  readonly correlationId?: string;
  /** Safe result metadata (never secrets, prompts, or stack traces). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Conflict kinds surfaced by the detector (Sprint 20 §14). */
export type ConflictType =
  | 'contradictory_outputs'
  | 'incompatible_statuses'
  | 'duplicate_results'
  | 'missing_dependency_output'
  | 'partial_execution'
  | 'agent_disagreement';

/** A detected, explicit conflict — never silently resolved off-policy. */
export interface ConflictRecord {
  readonly type: ConflictType;
  readonly taskIds: readonly string[];
  readonly detail: string;
  readonly resolved?: boolean;
}

/** Fully resolved conflict for a plan. */
export interface ConflictResolution {
  readonly conflicts: readonly ConflictRecord[];
  readonly decision: 'continue' | 'review_required' | 'fail';
  readonly selectedTaskId?: string;
  readonly message: string;
}

/** A safe, structured aggregate of coordinated results (Sprint 20 §13). */
export interface CoordinationAggregate {
  readonly strategy: AggregationStrategy;
  readonly output?: unknown;
  readonly successCount: number;
  readonly failureCount: number;
  readonly skippedCount: number;
  readonly totalCount: number;
  readonly conflicts: readonly ConflictRecord[];
  readonly mustReview: boolean;
  readonly selectedTaskId?: string;
  readonly error?: ExecutionError;
}

/** The final, aggregated outcome of a coordination run. */
export interface CoordinationResult {
  readonly coordinationId: string;
  readonly correlationId: string;
  readonly status: CoordinationStatus;
  readonly mode: CoordinationMode;
  readonly plan: CoordinationPlan;
  /** Deterministic task order (topological). */
  readonly tasks: readonly TaskResult[];
  readonly aggregate?: CoordinationAggregate;
  readonly conflicts: readonly ConflictRecord[];
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly durationMs: number;
  readonly cancelled?: boolean;
  readonly timedOut?: boolean;
  readonly error?: ExecutionError;
}

/** A controlled coordination message (Sprint 20 §10). */
export interface CoordinationMessage {
  readonly messageId: string;
  readonly coordinationId: string;
  readonly sender: AgentId;
  readonly recipient: AgentId;
  readonly messageType: string;
  /** Validated, bounded payload (treated as untrusted outside the sender). */
  readonly payload: unknown;
  readonly occurredAt: IsoTimestamp;
  readonly correlationId?: string;
  readonly schemaVersion: string;
}

/** Port for LLM-assisted decomposition (optional; not mandatory by default). */
export interface TaskDecompositionPort {
  readonly enabled: boolean;
  decompose(request: CoordinationRequest): Promise<readonly CoordinationTaskInput[] | undefined>;
}
