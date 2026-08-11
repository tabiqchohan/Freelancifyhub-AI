import type { AgentConfiguration } from '../../interfaces/execution-context.js';
import type { AgentId, IsoTimestamp, RequestId, TraceId } from '../../types/index.js';
import type { AgentStatus } from '../../types/index.js';
import type { IntentId, IntentResult, UserRole } from '../../intent/index.js';
import type { ContextSnapshot } from '../../context/index.js';
import type { AgentRequest } from '../../interfaces/agent-request.js';

/** Status of a completed routing attempt (prompt §1). */
export enum RoutingStatus {
  /** A primary agent was selected and is routable. */
  Success = 'success',
  /** A primary was unavailable and a fallback agent was selected. */
  Fallback = 'fallback',
  /** No agent could be routed; the decision escalates. */
  Escalated = 'escalated',
  /** Routing failed validation or produced an invalid route. */
  Failed = 'failed',
}

/** Deterministic routing strategies (prompt §7). */
export enum RoutingStrategy {
  /** Exact intent -> single agent match. */
  Direct = 'direct',
  /** Capability-based matching (intent support plus capability). */
  CapabilityMatch = 'capability-match',
  /** Priority-based selection (intent/agent priority). */
  Priority = 'priority',
  /** Fallback agent selected when the primary is unavailable. */
  Fallback = 'fallback',
  /** No routable agent; decision escalates. */
  Escalation = 'escalation',
}

/** Execution modes the decision may describe for a future planner (prompt §9). */
export enum ExecutionMode {
  Single = 'single',
  Parallel = 'parallel',
  Sequential = 'sequential',
  Conditional = 'conditional',
  Hybrid = 'hybrid',
}

/** Confidence buckets derived from the orchestrator spec §5 thresholds. */
export enum ConfidenceLevel {
  High = 'high',
  Medium = 'medium',
  Low = 'low',
}

/** Reason codes attached to escalation decisions (prompt §11). */
export enum EscalationReason {
  NoMatch = 'NO_MATCH',
  LowConfidence = 'LOW_CONFIDENCE',
  PermissionDenied = 'PERMISSION_DENIED',
  AgentUnavailable = 'AGENT_UNAVAILABLE',
  SystemConstraint = 'SYSTEM_CONSTRAINT',
}

/** Structured reason attached to a candidate or route (prompt §8). */
export interface RouteReason {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Explicit, configured scoring weights (prompt §6). */
export interface RouteScoreWeights {
  readonly intentMatch: number;
  readonly capabilityMatch: number;
  readonly roleCompatibility: number;
  readonly status: number;
  readonly priority: number;
  readonly cost: number;
  readonly availability: number;
  readonly constraintCompatibility: number;
}

/** Per-component scores making up a {@link RouteScore} total. */
export interface RouteScoreBreakdown {
  readonly intentMatch: number;
  readonly capabilityMatch: number;
  readonly roleCompatibility: number;
  readonly status: number;
  readonly priority: number;
  readonly cost: number;
  readonly availability: number;
  readonly constraintCompatibility: number;
}

/** Deterministic score of a routing candidate in [0,1]. */
export interface RouteScore {
  readonly total: number;
  readonly breakdown: RouteScoreBreakdown;
  readonly weights: RouteScoreWeights;
}

/** An agent that passed eligibility checks and was scored (prompt §8). */
export interface RouteCandidate {
  readonly agent: AgentConfiguration;
  readonly score: RouteScore;
  readonly reasons: readonly RouteReason[];
  readonly confidence: number;
  readonly strategy: RoutingStrategy;
}

/** A single routing fallback (prompt §10). */
export interface RouteFallback {
  /** The originally preferred agent id. */
  readonly originalAgentId: AgentId;
  /** The agent actually selected as the fallback. */
  readonly fallbackAgentId: AgentId;
  /** Why the fallback occurred. */
  readonly reason: string;
  readonly confidence: number;
}

/** Routing-level escalation metadata (prompt §11). */
export interface RouteEscalation {
  readonly reason: EscalationReason;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Metadata recorded for every routing decision (prompt §18). */
export interface RoutingMetadata {
  readonly version: string;
  readonly routedAt: IsoTimestamp;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly intentId: IntentId;
  readonly strategy: RoutingStrategy;
  readonly executionMode: ExecutionMode;
  readonly candidateCount: number;
  readonly fallbackCount: number;
  readonly escalated: boolean;
}

/** Logical constraints applied during routing (prompt §13). */
export interface RoutingConstraints {
  readonly allowedRoles?: readonly UserRole[];
  readonly requiredPermissions?: readonly string[];
  readonly requiredCapability?: string;
  readonly excludedAgents?: readonly AgentId[];
  readonly maxCandidates?: number;
  readonly maxRoutingCost?: number;
  readonly minConfidence?: number;
  readonly allowedStatuses?: readonly AgentStatus[];
}

/** The primary (selected) route (prompt §8). */
export interface AgentRoute {
  readonly agent: AgentConfiguration;
  readonly score: RouteScore;
  readonly confidence: number;
  readonly strategy: RoutingStrategy;
  readonly reasons: readonly RouteReason[];
}

/** Full, deterministic routing decision (prompt §18). */
export interface RouteDecision {
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly intentId: IntentId;
  readonly status: RoutingStatus;
  readonly strategy: RoutingStrategy;
  readonly executionMode: ExecutionMode;
  readonly confidence: number;
  readonly confidenceLevel: ConfidenceLevel;
  readonly confidenceThreshold: number;
  readonly selectedAgent?: AgentRoute;
  readonly candidates: readonly RouteCandidate[];
  readonly fallbacks: readonly RouteFallback[];
  readonly escalation?: RouteEscalation;
  readonly reasons: readonly RouteReason[];
  readonly metadata: RoutingMetadata;
}

/** Inputs consumed by the routing engine (prompt §1/§18). */
export interface RouteRequest {
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly request: AgentRequest;
  readonly intent: IntentResult;
  readonly context: ContextSnapshot;
  readonly role: UserRole;
  readonly constraints?: RoutingConstraints;
}

/** Top-level routing result consumed by the Sprint 5 planner (prompt §18). */
export interface RoutingResult {
  readonly decision: RouteDecision;
  readonly status: RoutingStatus;
}
