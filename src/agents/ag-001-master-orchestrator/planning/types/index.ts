import type { AgentId, IsoTimestamp, RequestId, TraceId } from '../../types/index.js';
import { ExecutionStatus } from '../../types/index.js';
import type { IntentId, IntentResult, UserRole } from '../../intent/index.js';
import type { ContextSnapshot } from '../../context/index.js';
import type { AgentRequest } from '../../interfaces/agent-request.js';
import type { RouteDecision } from '../../routing/types/index.js';
import { ExecutionMode } from '../../routing/types/index.js';

export { ExecutionMode, ExecutionStatus };

/** Structured source a step reference points at (prompt §15). */
export type ExecutionReferenceType = 'request' | 'context' | 'step' | 'route' | 'agent' | 'intent';

/** Declarative reference to a value available at execution time (never resolved). */
export interface ExecutionReference {
  /** Deterministic identifier, e.g. `request.input` or `step-2.output`. */
  readonly id: string;
  readonly type: ExecutionReferenceType;
  readonly optional?: boolean;
}

/** A declared dependency between two execution steps (prompt §8). */
export interface ExecutionDependency {
  /** The step that depends on another step. */
  readonly stepId: string;
  /** The step the current step depends on. */
  readonly dependsOn: string;
  /** Whether the dependency is required for the step to run. */
  readonly required: boolean;
}

/** Declarative condition operators (prompt §16). */
export enum ConditionOperator {
  Equals = 'EQUALS',
  NotEquals = 'NOT_EQUALS',
  GreaterThan = 'GREATER_THAN',
  LessThan = 'LESS_THAN',
  Exists = 'EXISTS',
  NotExists = 'NOT_EXISTS',
  Matches = 'MATCHES',
  And = 'AND',
  Or = 'OR',
  Not = 'NOT',
}

/** A typed, declarative condition. Never evaluated during planning. */
export interface ExecutionCondition {
  readonly id: string;
  readonly operator: ConditionOperator;
  /** Reference the condition reads, e.g. `route.confidence`. */
  readonly field?: string;
  readonly value?: string | number | boolean;
  /** Child condition ids for AND/OR/NOT. */
  readonly children?: readonly string[];
}

/** Structured failure policies carried as planning metadata (prompt §14). */
export enum FailurePolicy {
  FailFast = 'FAIL_FAST',
  Continue = 'CONTINUE',
  Fallback = 'FALLBACK',
  Escalate = 'ESCALATE',
}

/** Retry metadata attached to a step (prompt §13). */
export interface ExecutionRetryPolicy {
  readonly maxRetries: number;
  readonly retryable: boolean;
  readonly backoffMs?: number;
}

/** Execution policy metadata for a plan or step (prompt §13). */
export interface ExecutionPolicy {
  readonly timeoutMs: number;
  readonly retry: ExecutionRetryPolicy;
  readonly failureBehavior: FailurePolicy;
  readonly continueOnFailure: boolean;
  readonly stopOnFailure: boolean;
  readonly fallbackAllowed: boolean;
  readonly maxSteps: number;
  readonly maxTotalExecutionTimeMs: number;
}

/** Logical constraints applied during planning (prompt §9/§13). */
export interface ExecutionConstraints {
  readonly maxSteps?: number;
  readonly maxDepth?: number;
  readonly maxParallelBranches?: number;
  readonly maxTotalExecutionTimeMs?: number;
}

/** A single planned execution step (prompt §3/§4). */
export interface ExecutionStep {
  readonly stepId: string;
  readonly agentId: AgentId;
  readonly order: number;
  readonly capabilities: readonly string[];
  readonly dependencies: readonly ExecutionDependency[];
  readonly input: readonly ExecutionReference[];
  readonly output: readonly ExecutionReference[];
  readonly condition?: ExecutionCondition;
  readonly policy: ExecutionPolicy;
  readonly status: ExecutionStatus;
  readonly timeoutMs: number;
  readonly retry: ExecutionRetryPolicy;
}

/** A conditional branch of an execution plan (prompt §6). */
export interface ExecutionBranch {
  readonly branchId: string;
  readonly condition: ExecutionCondition;
  readonly stepIds: readonly string[];
  readonly order: number;
}

/** Metadata attached to every plan (prompt §18/§20). */
export interface ExecutionMetadata {
  readonly version: string;
  readonly createdAt: IsoTimestamp;
  readonly planId: string;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly intentId: IntentId;
  readonly executionMode: ExecutionMode;
  readonly stepCount: number;
  readonly dependencyCount: number;
  readonly branchCount: number;
  readonly conditionCount: number;
  readonly optimizationCount: number;
  readonly warningCount: number;
}

/** A structured, non-fatal problem surfaced during planning. */
export interface PlanningWarning {
  readonly code: string;
  readonly message: string;
  readonly stepId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Deterministic statistics produced for every plan (prompt §21). */
export interface PlanningStatistics {
  readonly stepCount: number;
  readonly agentCount: number;
  readonly dependencyCount: number;
  readonly parallelBranchCount: number;
  readonly conditionalBranchCount: number;
  readonly maximumDepth: number;
  readonly estimatedExecutionStages: number;
  readonly optimizationCount: number;
  readonly warningCount: number;
}

/** The immutable, declarative execution plan (prompt §1). */
export interface ExecutionPlan {
  readonly planId: string;
  readonly version: string;
  readonly createdAt: IsoTimestamp;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly intentId: IntentId;
  readonly role: UserRole;
  readonly mode: ExecutionMode;
  readonly steps: readonly ExecutionStep[];
  readonly dependencies: readonly ExecutionDependency[];
  readonly conditions: readonly ExecutionCondition[];
  readonly branches: readonly ExecutionBranch[];
  readonly policy: ExecutionPolicy;
  readonly constraints: ExecutionConstraints;
  readonly metadata: ExecutionMetadata;
  readonly warnings: readonly PlanningWarning[];
  readonly statistics: PlanningStatistics;
}

/** Top-level planning result consumed by the orchestrator. */
export interface ExecutionPlanResult {
  readonly plan: ExecutionPlan;
  readonly warnings: readonly PlanningWarning[];
  readonly statistics: PlanningStatistics;
}

/** Inputs consumed by the plan builder (prompt §1/§11). */
export interface PlanningRequest {
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly request: AgentRequest;
  readonly intent: IntentResult;
  readonly context: ContextSnapshot;
  readonly route: RouteDecision;
  readonly role: UserRole;
  readonly constraints?: ExecutionConstraints;
}

export type { RouteDecision, AgentRequest, ContextSnapshot, IntentResult, AgentId };
