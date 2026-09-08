/**
 * Sprint 21 — Client AI Team v1. Domain contracts.
 *
 * Every public value crossing the Client AI boundary is typed, bounded and
 * secret-free. `ClientRequest` is the validated service input (the
 * serializable portion is schema-validated; `cancellation` is re-attached
 * after parsing). `ClientResult` is the final client-facing contract
 * (Sprint 21 §16): a string response plus safe structured data.
 */

import type { ExecutionError } from '../ag-001-master-orchestrator/execution/index.js';

export type { ExecutionError };

/** Status of a completed client-AI request. */
export type ClientRequestStatus =
  'COMPLETED' | 'COMPLETED_PARTIAL' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

/** Cooperative cancellation handle propagated to executions. */
export interface ClientCancellation {
  readonly requested: boolean;
  readonly signal: AbortSignal;
}

/** Client/user scope used for AG-002/AG-003/AG-004 authorization. */
export interface ClientActor {
  readonly actorId: string;
  /** Explicit namespace allow-list (fail-closed when empty). */
  readonly namespaces: readonly string[];
  readonly role?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectIds?: readonly string[];
  readonly securityClearance?: string;
}

/** Structured input accepted by the service (bounded by validation). */
export interface ClientRequestInput {
  readonly brief?: string;
  readonly headline?: string;
  readonly requirements?: readonly string[];
  readonly budget?: { readonly min?: number; readonly max?: number };
  readonly timeline?: { readonly weeksMin?: number; readonly weeksMax?: number };
  readonly skills?: readonly string[];
  readonly durationHours?: number;
  readonly [key: string]: unknown;
}

/** A direct capability task (takes precedence over intent when provided). */
export interface ClientTaskSpec {
  readonly capabilityId: string;
  readonly agentId?: string;
  readonly objective?: string;
  readonly requiredTools?: readonly string[];
  readonly toolCalls?: readonly { readonly name: string; readonly input: unknown }[];
  readonly mode?: 'single' | 'agentic';
}

/** A validated client-AI request. */
export interface ClientRequest {
  readonly clientRequestId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  /** AG-001 detected intent id — authoritative for routing. */
  readonly intent?: string;
  readonly task?: ClientTaskSpec;
  /** Structured, bounded input (brief/headline/requirements/budget/...). */
  readonly input: ClientRequestInput;
  readonly actor: ClientActor;
  readonly limits?: { readonly timeoutMs?: number; readonly globalTimeoutMs?: number };
  readonly cancellation?: ClientCancellation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The deterministic route selected for a validated request. */
export type ClientRoute =
  | { readonly kind: 'single'; readonly agentId: string; readonly capabilityId: string }
  | { readonly kind: 'workflow'; readonly workflowId: string };

/** A bounded, sanitized context item delivered to a client agent. */
export interface ClientContextItem {
  readonly id: string;
  readonly namespace: string;
  readonly key: string;
  readonly content: string;
  readonly source: string;
}

/** Bounded, sanitized request context (memory + knowledge, deduplicated). */
export interface ClientContext {
  readonly memory: readonly ClientContextItem[];
  readonly knowledge: readonly ClientContextItem[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

/** A single recommendation emitted by a client agent. */
export interface ClientRecommendation {
  readonly agentId: string;
  readonly capability: string;
  readonly title: string;
  readonly recommendation: string;
  readonly urgency?: 'low' | 'medium' | 'high';
  readonly confidence?: number;
}

/** A sanitized, typed result for one client agent section. */
export interface ClientSection {
  readonly taskId?: string;
  readonly agentId: string;
  readonly capability: string;
  readonly status: 'success' | 'failure' | 'skipped';
  readonly output?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code: string; readonly message: string };
}

/** The final client-facing result (always a string response + safe data). */
export interface ClientResult {
  readonly clientRequestId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly status: ClientRequestStatus;
  readonly intent?: string;
  readonly routeKind?: 'single' | 'workflow';
  readonly agents: readonly string[];
  /** Human-readable final response — always present (Sprint 21 §16). */
  readonly response: string;
  readonly structuredData?: Readonly<Record<string, unknown>>;
  readonly recommendations?: readonly ClientRecommendation[];
  readonly confidence?: number;
  readonly sections?: readonly ClientSection[];
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

/** Safe aggregated output shape produced by the project-creation workflow. */
export interface ClientWorkflowAggregate {
  readonly description?: Readonly<Record<string, unknown>>;
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly timeline?: Readonly<Record<string, unknown>>;
  readonly skills?: Readonly<Record<string, unknown>>;
  readonly [taskId: string]: Readonly<Record<string, unknown>> | undefined;
}

/** A single executable step command produced by {@link ClientAgentEngine}. */
export interface ClientStepCommand {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly requiredTools?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly taskId?: string;
  readonly dependencies?: readonly string[];
  readonly timeoutMs?: number;
}
