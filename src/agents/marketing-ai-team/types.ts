/**
 * Sprint 24 — Marketing AI Team v1. Domain contracts.
 *
 * Every value crossing the Marketing AI boundary is typed, bounded and
 * secret-free. `MarketingRequest` is the validated service input (the
 * serializable portion is schema-validated; `cancellation` is re-attached
 * after parsing). `MarketingResult` is the final marketing-facing contract: a
 * string response plus safe structured data. Deterministic agents consume
 * structured input only and never fabricate research findings, engagement
 * metrics or campaign predictions (Sprint 24 §6, §13). Drafts that need human
 * copy or review report `dataSufficient`/`draftComplete` honestly and are
 * never surfaced as publish-ready.
 */

import type { ExecutionError } from '../ag-001-master-orchestrator/execution/index.js';

export type { ExecutionError };

/** Status of a completed marketing-AI request. */
export type MarketingRequestStatus =
  'COMPLETED' | 'COMPLETED_PARTIAL' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

/** Cooperative cancellation handle propagated to executions. */
export interface MarketingCancellation {
  readonly requested: boolean;
  readonly signal: AbortSignal;
}

/** Marketing/user scope used for AG-002/AG-003/AG-004 authorization. */
export interface MarketingActor {
  readonly actorId: string;
  /** Explicit namespace allow-list (fail-closed when empty). */
  readonly namespaces: readonly string[];
  readonly role?: string;
  readonly securityClearance?: string;
  readonly availability?: string;
}

/** Brand keywords that ground on-brand copy (catalog AG-402/AG-403/AG-405). */
export interface MarketingBrandKeywords {
  readonly keywords: readonly string[];
}

/** A cited research source (research agent input — BR-AI-4). */
export interface MarketingSource {
  readonly source: string;
  readonly claim?: string;
  readonly url?: string;
}

/** Research brief + sources (AG-401 input/output contract). */
export interface MarketingResearchBrief {
  readonly brief?: string;
  readonly focus?: string;
  readonly sources?: readonly MarketingSource[];
}

/** Social content brief (AG-402 input contract). */
export interface MarketingSocialBrief {
  readonly platform?: string;
  readonly audience?: string;
  readonly goal?: string;
  readonly brandKeywords?: readonly string[];
  readonly userDraft?: string;
}

/** Blog content brief (AG-403 input contract). */
export interface MarketingBlogBrief {
  readonly topic?: string;
  readonly outline?: string;
  readonly seoKeywords?: readonly string[];
  readonly audience?: string;
  readonly brandKeywords?: readonly string[];
  readonly userDraft?: string;
}

/** On-page SEO snapshot (AG-404 input contract). */
export interface MarketingSeoInput {
  readonly title?: string;
  readonly metaDescription?: string;
  readonly headings?: readonly string[];
  readonly body?: string;
  readonly keywords?: readonly string[];
}

/** Email brief (AG-405 input contract — opt-out aware, sends gated). */
export interface MarketingEmailBrief {
  readonly audience?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly cta?: string;
  readonly tone?: string;
  readonly campaignType?: string;
  readonly brandKeywords?: readonly string[];
}

/** Structured input accepted by the service (bounded by validation). */
export interface MarketingRequestInput {
  readonly research?: MarketingResearchBrief;
  readonly social?: MarketingSocialBrief;
  readonly blog?: MarketingBlogBrief;
  readonly seo?: MarketingSeoInput;
  readonly email?: MarketingEmailBrief;
  readonly [key: string]: unknown;
}

/** A direct capability task (takes precedence over intent when provided). */
export interface MarketingTaskSpec {
  readonly capabilityId: string;
  readonly agentId?: string;
  readonly objective?: string;
  readonly requiredTools?: readonly string[];
  readonly toolCalls?: readonly { readonly name: string; readonly input: unknown }[];
  readonly mode?: 'single' | 'agentic';
}

/** A validated marketing-AI request. */
export interface MarketingRequest {
  readonly marketingRequestId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  /** AG-001 detected intent id — authoritative for routing. */
  readonly intent?: string;
  readonly task?: MarketingTaskSpec;
  /** Structured, bounded input (research/social/blog/seo/email). */
  readonly input: MarketingRequestInput;
  readonly actor: MarketingActor;
  readonly limits?: { readonly timeoutMs?: number; readonly globalTimeoutMs?: number };
  readonly cancellation?: MarketingCancellation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The deterministic route selected for a validated request. */
export type MarketingRoute =
  | { readonly kind: 'single'; readonly agentId: string; readonly capabilityId: string }
  | { readonly kind: 'workflow'; readonly workflowId: string };

/** A bounded, sanitized context item delivered to a marketing agent. */
export interface MarketingContextItem {
  readonly id: string;
  readonly namespace: string;
  readonly key: string;
  readonly content: string;
  readonly source: string;
}

/** Bounded, sanitized request context (memory + knowledge, deduplicated). */
export interface MarketingContext {
  readonly memory: readonly MarketingContextItem[];
  readonly knowledge: readonly MarketingContextItem[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

/** A single recommendation emitted by a marketing agent. */
export interface MarketingRecommendation {
  readonly agentId: string;
  readonly capability: string;
  readonly title: string;
  readonly recommendation: string;
  readonly urgency?: 'low' | 'medium' | 'high';
  readonly confidence?: number;
}

/** A sanitized, typed result for one marketing agent section. */
export interface MarketingSection {
  readonly taskId?: string;
  readonly agentId: string;
  readonly capability: string;
  readonly status: 'success' | 'failure' | 'skipped';
  readonly output?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code: string; readonly message: string };
}

/** The final marketing-facing result (always a string response + safe data). */
export interface MarketingResult {
  readonly marketingRequestId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly status: MarketingRequestStatus;
  readonly intent?: string;
  readonly routeKind?: 'single' | 'workflow';
  readonly agents: readonly string[];
  /** Human-readable final response — always present (Sprint 24 §19). */
  readonly response: string;
  readonly structuredData?: Readonly<Record<string, unknown>>;
  readonly recommendations?: readonly MarketingRecommendation[];
  readonly confidence?: number;
  readonly sections?: readonly MarketingSection[];
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

/** Safe aggregated output shape produced by the campaign workflow. */
export interface MarketingWorkflowAggregate {
  readonly research?: Readonly<Record<string, unknown>>;
  readonly social?: Readonly<Record<string, unknown>>;
  readonly email?: Readonly<Record<string, unknown>>;
  readonly [taskId: string]: Readonly<Record<string, unknown>> | undefined;
}

/** A single executable step command produced by the marketing agent engine. */
export interface MarketingStepCommand {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly requiredTools?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly taskId?: string;
  readonly dependencies?: readonly string[];
  readonly timeoutMs?: number;
}
