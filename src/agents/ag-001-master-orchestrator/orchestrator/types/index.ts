import { AggregationStatus } from '../../aggregation/index.js';
import type { AggregatedResponse } from '../../aggregation/index.js';
import type { ContextBudget, ContextItemInput } from '../../context/index.js';
import type { ExecutionResult } from '../../execution/index.js';
import type { IntentResult, UserRole } from '../../intent/index.js';
import type { ExecutionConstraints, ExecutionPlan } from '../../planning/index.js';
import type { RouteDecision, RouteEscalation, RoutingConstraints } from '../../routing/index.js';
import type { IsoTimestamp, RequestId, TraceId } from '../../types/index.js';

export { AggregationStatus };

/** A normalized request with correlation identifiers guaranteed to be set. */
export type NormalizedOrchestrationRequest = Omit<OrchestrationRequest, 'requestId' | 'traceId'> & {
  readonly requestId: RequestId;
  readonly traceId: TraceId;
};

/** Logical stages of the orchestration lifecycle (spec §4, prompt §3). */
export enum OrchestratorStage {
  Validation = 'VALIDATION',
  IntentDetection = 'INTENT_DETECTION',
  ContextBuilding = 'CONTEXT_BUILDING',
  Routing = 'ROUTING',
  Planning = 'PLANNING',
  Execution = 'EXECUTION',
  Aggregation = 'AGGREGATION',
  Response = 'RESPONSE',
}

/**
 * Input accepted by {@link MasterOrchestratorService}. The service fills any
 * missing correlation identifiers and never mutates the caller's object.
 */
export interface OrchestrationRequest {
  /** Raw user text the orchestrator classifies and orchestrates. */
  readonly text: string;
  /** User role used for authorization and routing. */
  readonly role: UserRole;
  /** Caller-supplied correlation id (generated when missing). */
  readonly requestId?: RequestId;
  /** Caller-supplied trace/correlation id (generated when missing). */
  readonly traceId?: TraceId;
  /** Optional source description (for example the calling gateway). */
  readonly origin?: string;
  /** Additional context items assembled by the Context Builder. */
  readonly contextItems?: readonly ContextItemInput[];
  /** Optional context budget overrides on top of configured defaults. */
  readonly budget?: Partial<ContextBudget>;
  /** Optional routing constraints honoured by the Routing Engine. */
  readonly routingConstraints?: RoutingConstraints;
  /** Optional planning constraints honoured by the Execution Planner. */
  readonly planningConstraints?: ExecutionConstraints;
}

/**
 * The final, traceable orchestration response. Every stage artifact that is
 * required for auditability is preserved (no silent data loss), while the
 * aggregation output remains the authoritative response body.
 */
export interface OrchestratorResponse {
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  /** Terminal status derived from the aggregation (never overwritten). */
  readonly status: AggregationStatus;
  /** The terminal lifecycle stage reached by this request. */
  readonly stage: OrchestratorStage;
  readonly intent: IntentResult;
  readonly route: RouteDecision;
  /** Present once planning succeeded (fail-closed paths omit it). */
  readonly plan?: ExecutionPlan;
  /** Present once execution ran (fail-closed/cancelled-before-run omit it). */
  readonly execution?: ExecutionResult;
  /** The aggregated response body (omitted on fail-closed paths). */
  readonly aggregated?: AggregatedResponse;
  /** Present when the route escalated and the request failed closed. */
  readonly escalation?: RouteEscalation;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly durationMs: number;
}
