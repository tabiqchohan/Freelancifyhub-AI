/**
 * Sprint 25 — Admin AI Team v1. Domain contracts.
 *
 * Every value crossing the Admin AI boundary is typed, bounded and
 * secret-free. `AdminRequest` is the validated service input (the
 * serializable portion is schema-validated; `cancellation` is re-attached
 * after parsing). `AdminResult` is the final admin-facing contract: a string
 * response plus safe structured data. Deterministic agents consume structured
 * input only and never fabricate platform metrics (users, revenue, conversion,
 * fraud rate, health SLOs — prompt §19). Anything that cannot be derived from
 * the supplied facts reports `dataSufficient`/`insufficientData` honestly,
 * estimates are explicitly marked, and mutating recommendations always carry
 * an approval requirement (BR-ADM-2, prompt §15) — the admin team never
 * executes a privileged write on behalf of user text.
 */

import type { ExecutionError } from '../ag-001-master-orchestrator/execution/index.js';

export type { ExecutionError };

/** Status of a completed admin-AI request. */
export type AdminRequestStatus =
  'COMPLETED' | 'COMPLETED_PARTIAL' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

/** Cooperative cancellation handle propagated to executions. */
export interface AdminCancellation {
  readonly requested: boolean;
  readonly signal: AbortSignal;
}

/** Admin/user scope used for AG-002/AG-003/AG-004 + admin authorization. */
export interface AdminActor {
  readonly actorId: string;
  /** Explicit namespace allow-list (fail-closed when empty). */
  readonly namespaces: readonly string[];
  readonly role?: string;
  /**
   * Explicit role scopes the actor may act within (BR-ADM-1:
   * users/projects/payments/disputes/fraud/ai). Fail-closed when empty.
   */
  readonly adminScopes?: readonly string[];
  readonly securityClearance?: string;
  readonly availability?: string;
}

/** A permitted analytics dataset scope for F21 queries. */
export interface AdminPermittedDataset {
  readonly scope: string;
  readonly dataset: string;
}

/** A single fraud signal fact (AG-502 input — supplied by the platform). */
export interface AdminFraudSignal {
  readonly signalId: string;
  readonly signalType?: string;
  readonly severity?: string;
  readonly observedAt: string;
  readonly evidence?: readonly { readonly label?: string; readonly detail?: string }[];
}

/** An observed platform metric fact (AG-503 input — supplied, never invented). */
export interface AdminMetricFact {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly threshold?: number;
  readonly observedAt?: string;
}

/** An observed aggregated KPI fact (AG-505 input — aggregated only). */
export interface AdminKpiFact {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly period?: string;
  readonly note?: string;
}

/** A proposed AI-ecosystem configuration change (AG-504 input). */
export interface AdminAiChangeProposal {
  readonly changeType: 'feature-flag' | 'model-route' | 'prompt-version' | 'cost-cap';
  readonly target: string;
  readonly value?: string;
  readonly reversible?: boolean;
  readonly reason?: string;
}

/** Structured input accepted by the service (bounded by validation). */
export interface AdminRequestInput {
  readonly action?: {
    readonly kind?: string;
    readonly domain?: string;
    readonly target?: string;
    readonly reason?: string;
  };
  readonly analytics?: {
    readonly query?: string;
    readonly permittedDataset?: readonly AdminPermittedDataset[];
    readonly facts?: readonly AdminKpiFact[];
  };
  readonly fraud?: {
    readonly signals?: readonly AdminFraudSignal[];
    readonly policyScope?: string;
  };
  readonly health?: {
    readonly metrics?: readonly AdminMetricFact[];
    readonly serviceTopology?: readonly { readonly service?: string; readonly healthy?: boolean }[];
  };
  readonly aiops?: {
    readonly change?: AdminAiChangeProposal;
    readonly costFacts?: readonly AdminKpiFact[];
  };
  readonly executive?: {
    readonly kpis?: readonly AdminKpiFact[];
    readonly period?: string;
  };
  readonly [key: string]: unknown;
}

/** A direct capability task (takes precedence over intent when provided). */
export interface AdminTaskSpec {
  readonly capabilityId: string;
  readonly agentId?: string;
  readonly objective?: string;
  readonly requiredTools?: readonly string[];
  readonly toolCalls?: readonly { readonly name: string; readonly input: unknown }[];
  readonly mode?: 'single' | 'agentic';
}

/** A validated admin-AI request. */
export interface AdminRequest {
  readonly adminRequestId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  /** AG-001 detected intent id — authoritative for routing. */
  readonly intent?: string;
  readonly task?: AdminTaskSpec;
  /** Structured, bounded input (analytics/fraud/health/aiops/executive). */
  readonly input: AdminRequestInput;
  readonly actor: AdminActor;
  readonly limits?: { readonly timeoutMs?: number; readonly globalTimeoutMs?: number };
  readonly cancellation?: AdminCancellation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The deterministic route selected for a validated request. */
export type AdminRoute =
  | { readonly kind: 'single'; readonly agentId: string; readonly capabilityId: string }
  | { readonly kind: 'workflow'; readonly workflowId: string };

/** A bounded, sanitized context item delivered to an admin agent. */
export interface AdminContextItem {
  readonly id: string;
  readonly namespace: string;
  readonly key: string;
  readonly content: string;
  readonly source: string;
}

/** Bounded, sanitized request context (memory + knowledge, deduplicated). */
export interface AdminContext {
  readonly memory: readonly AdminContextItem[];
  readonly knowledge: readonly AdminContextItem[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

/** Approval/audit status attached to a privileged recommendation. */
export interface AdminRecommendation {
  readonly agentId: string;
  readonly capability: string;
  readonly title: string;
  readonly recommendation: string;
  readonly rationale?: string;
  readonly priority?: 'low' | 'medium' | 'high';
  readonly confidence?: number;
  readonly supportingSignals?: readonly string[];
  readonly assumptions?: readonly string[];
  /** Marked true whenever the recommendation would mutate platform state. */
  readonly approvalRequired?: boolean;
  /** Read vs mutating classification (prompt §15). */
  readonly actionKind?: 'read' | 'mutating';
}

/** A sanitized, typed result for one admin agent section. */
export interface AdminSection {
  readonly taskId?: string;
  readonly agentId: string;
  readonly capability: string;
  readonly status: 'success' | 'failure' | 'skipped';
  readonly output?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code: string; readonly message: string };
}

/** The final admin-facing result (always a string response + safe data). */
export interface AdminResult {
  readonly adminRequestId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly status: AdminRequestStatus;
  readonly intent?: string;
  readonly routeKind?: 'single' | 'workflow';
  readonly agents: readonly string[];
  /** Human-readable final response — always present (Sprint 25 §28). */
  readonly response: string;
  readonly structuredData?: Readonly<Record<string, unknown>>;
  readonly recommendations?: readonly AdminRecommendation[];
  readonly confidence?: number;
  readonly sections?: readonly AdminSection[];
  readonly coordinationId?: string;
  readonly coordinationStatus?: string;
  readonly memoryReferences?: readonly string[];
  readonly knowledgeReferences?: readonly string[];
  readonly context?: {
    readonly memoryItems: number;
    readonly knowledgeDocs: number;
    readonly truncated: boolean;
  };
  readonly toolUsage?: {
    readonly calls: number;
    readonly successes: number;
    readonly failures: number;
  };
  readonly timing: {
    readonly startedAt: string;
    readonly completedAt: string;
    readonly durationMs: number;
  };
  readonly warnings: readonly string[];
  readonly errors: readonly { readonly code: string; readonly message: string }[];
}

/** Safe aggregated output shape produced by the executive workflow. */
export interface AdminWorkflowAggregate {
  readonly analytics?: Readonly<Record<string, unknown>>;
  readonly health?: Readonly<Record<string, unknown>>;
  readonly fraud?: Readonly<Record<string, unknown>>;
  readonly [taskId: string]: Readonly<Record<string, unknown>> | undefined;
}

/** A single executable step command produced by the admin agent engine. */
export interface AdminStepCommand {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly requiredTools?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly taskId?: string;
  readonly dependencies?: readonly string[];
  readonly timeoutMs?: number;
}
