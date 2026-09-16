/**
 * Sprint 26 — AI Operating System integration layer. Domain contracts.
 *
 * Every value crossing the AIOS boundary is typed, bounded and secret-free.
 * The AIOS stays a thin operating layer over the existing architecture: it
 * classifies intent with AG-001's classifier, derives its dispatch from
 * AG-001's intent registry data (team ownership is read from
 * `supportedAgents`/`category` — no second routing table), provisions memory
 * context through the request actor registry, and executes the request through
 * either the owning AI team service (client/freelancer/marketplace/marketing/
 * admin) or AG-001's orchestrator tail. It never replaces, redesigns or
 * duplicates an existing agent path.
 */

import type { AggregationStatus } from '../agents/ag-001-master-orchestrator/aggregation/index.js';
import type { IntentResult, UserRole } from '../agents/ag-001-master-orchestrator/intent/index.js';

export type { AggregationStatus };

/** Request status vocabulary (reused from the architecture status enum). */
export type AiosRequestStatus = AggregationStatus;

/** Lifecycle stages of the AIOS pipeline (Sprint 26 §3). */
export enum AiosStage {
  Validate = 'VALIDATE',
  CreateRequestContext = 'CREATE_REQUEST_CONTEXT',
  DetectIntent = 'DETECT_INTENT',
  BuildContext = 'BUILD_CONTEXT',
  Authorize = 'AUTHORIZE',
  Route = 'ROUTE',
  Plan = 'PLAN',
  Execute = 'EXECUTE',
  Aggregate = 'AGGREGATE',
  SafetyCheck = 'SAFETY_CHECK',
  PersistEvents = 'PERSIST_EVENTS',
  UpdateMetrics = 'UPDATE_METRICS',
  FinalizeResponse = 'FINALIZE_RESPONSE',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
  Cancelled = 'CANCELLED',
}

/** The execution tail chosen by the AIOS route (derived from AG-001 data). */
export type AiosExecutionTarget =
  | { readonly kind: 'client' }
  | { readonly kind: 'freelancer' }
  | { readonly kind: 'marketplace' }
  | { readonly kind: 'marketing' }
  | { readonly kind: 'admin' }
  | { readonly kind: 'orchestrator' };

/** A bounded caller/actor identity accepted by the AIOS boundary. */
export interface AiosActor {
  readonly actorId: string;
  /** User role used for authorization (AG-001 vocabulary). */
  readonly role: UserRole;
  /** Memory actor group value (AG-002 vocabulary). */
  readonly group?: string;
  /** Explicit namespace allow-list (fail-closed when empty). */
  readonly namespaces: readonly string[];
  /** Explicit admin role scopes (BR-ADM-1; fail-closed when empty). */
  readonly adminScopes?: readonly string[];
  readonly securityClearance?: string;
}

/** A single structured (schema-bounded) request body. */
export interface AiosInput {
  /** Free-form user text the AIOS classifies and orchestrates. */
  readonly text: string;
  /** Optional structured input passed through to the owning team. */
  readonly structured?: Readonly<Record<string, unknown>>;
}

/** Per-request execution knobs (bounded, never exposed to agent logic). */
export interface AiosRequestOptions {
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A validated request accepted by the AIOS boundary. */
export interface AiosRequest {
  readonly requestId: string;
  readonly traceId?: string;
  readonly input: AiosInput;
  readonly actor: AiosActor;
  readonly options?: AiosRequestOptions;
}

/** The route selected for an AIOS request (derived from AG-001 data). */
export interface AiosRouteInfo {
  readonly intentId: string;
  readonly intentCategory?: string;
  readonly supportedAgents: readonly string[];
  readonly confidence: number;
  readonly target: AiosExecutionTarget;
}

/** Aggregated execution detail preserved on the final response. */
export interface AiosExecutionDetail {
  readonly target: AiosExecutionTarget;
  readonly route: AiosRouteInfo;
  readonly intent: IntentResult;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly agents?: readonly string[];
  readonly coordinationId?: string;
  readonly coordinationStatus?: string;
  readonly memoryReferences?: readonly string[];
  readonly knowledgeReferences?: readonly string[];
}

/** The final, safe AIOS response returned to callers. */
export interface AiosResponse {
  readonly requestId: string;
  readonly traceId: string;
  readonly status: AiosRequestStatus;
  readonly intent: string;
  readonly response: string;
  readonly structuredData?: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly stages: readonly AiosStage[];
  readonly execution: AiosExecutionDetail;
}

/** A typed, injected AIOS event (system of record — Sprint 26 §6). */
export interface AiosEvent {
  readonly eventId: string;
  readonly requestId: string;
  readonly traceId?: string;
  readonly type: string;
  readonly stage?: AiosStage;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Snapshot of the AIOS operating state (Sprint 26 §8). */
export interface AiosStatus {
  readonly enabled: boolean;
  readonly healthy: boolean;
  readonly stage: AiosStage;
  readonly activeRequests: number;
  readonly completedRequests: number;
  readonly requestCounts: Readonly<Record<string, number>>;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly lastFailure?: string;
  readonly since: string;
}

/** Contract satisfied by the AIOS request entry point. */
export interface AiosGatewayContract {
  readonly name: string;
  readonly version: string;
  request(req: AiosRequest): Promise<AiosResponse>;
  status(requestId: string): AiosStatus;
  cancel(requestId: string): void;
}
