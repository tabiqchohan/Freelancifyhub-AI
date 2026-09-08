/**
 * Sprint 23 — Marketplace AI Team v1. Domain contracts.
 *
 * Every value crossing the Marketplace AI boundary is typed, bounded and
 * secret-free. `MarketplaceRequest` is the validated service input (the
 * serializable portion is schema-validated; `cancellation` is re-attached
 * after parsing). `MarketplaceResult` is the final marketplace-facing contract:
 * a string response plus safe structured data. Deterministic agents consume
 * structured input only and never fabricate marketplace facts (Sprint 23 §6,
 * §45). Dataset-dependent features report `insufficientData` honestly.
 */

import type { ExecutionError } from '../ag-001-master-orchestrator/execution/index.js';

export type { ExecutionError };

/** Status of a completed marketplace-AI request. */
export type MarketplaceRequestStatus =
  'COMPLETED' | 'COMPLETED_PARTIAL' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

/** Cooperative cancellation handle propagated to executions. */
export interface MarketplaceCancellation {
  readonly requested: boolean;
  readonly signal: AbortSignal;
}

/** Marketplace/user scope used for AG-002/AG-003/AG-004 authorization. */
export interface MarketplaceActor {
  readonly actorId: string;
  /** Explicit namespace allow-list (fail-closed when empty). */
  readonly namespaces: readonly string[];
  readonly role?: string;
  readonly securityClearance?: string;
  readonly availability?: string;
}

/** A project under evaluation (discovery/matching/quality/insights input). */
export interface MarketplaceProject {
  readonly title?: string;
  readonly description?: string;
  readonly requirements?: readonly string[];
  readonly requiredSkills?: readonly string[];
  readonly category?: string;
  readonly budget?: { readonly min?: number; readonly max?: number };
  readonly timeline?: { readonly weeksMin?: number; readonly weeksMax?: number };
  readonly status?: string;
  readonly deliverables?: readonly string[];
}

/** A freelancer's declared profile (matching/opportunity input). */
export interface MarketplaceFreelancer {
  readonly id?: string;
  readonly headline?: string;
  readonly bio?: string;
  readonly skills?: readonly string[];
  readonly experience?: { readonly years?: number };
  readonly portfolioUrl?: string;
  readonly hourlyRate?: number;
  readonly category?: string;
  readonly availability?: string;
}

/** Agreed engagement terms (contract + milestone planning input). */
export interface MarketplaceAgreement {
  readonly parties?: {
    readonly clientId?: string;
    readonly freelancerId?: string;
    readonly clientName?: string;
    readonly freelancerName?: string;
  };
  readonly budget?: { readonly min?: number; readonly max?: number };
  readonly fee?: number;
  readonly milestones?: readonly MarketplaceMilestone[];
  readonly terms?: readonly string[];
  readonly jurisdiction?: string;
}

/** A single proposed milestone (deliverable/amount/date split). */
export interface MarketplaceMilestone {
  readonly title: string;
  readonly amount: number;
  readonly dueWeeks?: number;
  readonly deliverable?: string;
}

/** An incoming marketplace message (messaging filter input). */
export interface MarketplaceMessage {
  readonly senderId?: string;
  readonly recipientId?: string;
  readonly body: string;
  readonly context?: string;
}

/** Risk signals observed for an actor/engagement (scam-detection input). */
export interface MarketplaceRiskSignals {
  readonly newAccount?: boolean;
  readonly contactOffPlatform?: boolean;
  readonly paymentOutsidePlatform?: boolean;
  readonly urgencyPressure?: boolean;
  readonly suspiciousLink?: boolean;
  readonly messageCount?: number;
  readonly reportedBefore?: boolean;
}

/** Engagement outcome facts for a review draft (review-generator input). */
export interface MarketplaceReview {
  readonly engagementId?: string;
  readonly parties?: { readonly reviewerId?: string; readonly reviewedId?: string };
  readonly outcomeAgreed?: boolean;
  readonly messages?: readonly string[];
  readonly deliveredOnTime?: boolean;
  readonly qualityNotes?: string;
  readonly milestonesCount?: number;
}

/** Dispute record facts for the dispute assistant (no subjective judgment). */
export interface MarketplaceDispute {
  readonly disputeId?: string;
  readonly reason?: string;
  readonly openedAt?: string;
  readonly messages?: readonly string[];
  readonly deliverables?: readonly string[];
  readonly payments?: readonly number[];
  readonly status?: string;
}

/** A user-supplied dataset of marketplace projects (insights/discovery). */
export interface MarketplaceDataset {
  readonly projects?: readonly MarketplaceProject[];
  readonly categories?: readonly string[];
}

/** Structured input accepted by the service (bounded by validation). */
export interface MarketplaceRequestInput {
  readonly project?: MarketplaceProject;
  readonly freelancer?: MarketplaceFreelancer;
  readonly agreement?: MarketplaceAgreement;
  readonly message?: MarketplaceMessage;
  readonly signals?: MarketplaceRiskSignals;
  readonly review?: MarketplaceReview;
  readonly dispute?: MarketplaceDispute;
  readonly marketplace?: MarketplaceDataset;
  readonly [key: string]: unknown;
}

/** A direct capability task (takes precedence over intent when provided). */
export interface MarketplaceTaskSpec {
  readonly capabilityId: string;
  readonly agentId?: string;
  readonly objective?: string;
  readonly requiredTools?: readonly string[];
  readonly toolCalls?: readonly { readonly name: string; readonly input: unknown }[];
  readonly mode?: 'single' | 'agentic';
}

/** A validated marketplace-AI request. */
export interface MarketplaceRequest {
  readonly marketplaceRequestId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  /** AG-001 detected intent id — authoritative for routing. */
  readonly intent?: string;
  readonly task?: MarketplaceTaskSpec;
  /** Structured, bounded input (project/freelancer/agreement/...). */
  readonly input: MarketplaceRequestInput;
  readonly actor: MarketplaceActor;
  readonly limits?: { readonly timeoutMs?: number; readonly globalTimeoutMs?: number };
  readonly cancellation?: MarketplaceCancellation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The deterministic route selected for a validated request. */
export type MarketplaceRoute =
  | { readonly kind: 'single'; readonly agentId: string; readonly capabilityId: string }
  | { readonly kind: 'workflow'; readonly workflowId: string };

/** A bounded, sanitized context item delivered to a marketplace agent. */
export interface MarketplaceContextItem {
  readonly id: string;
  readonly namespace: string;
  readonly key: string;
  readonly content: string;
  readonly source: string;
}

/** Bounded, sanitized request context (memory + knowledge, deduplicated). */
export interface MarketplaceContext {
  readonly memory: readonly MarketplaceContextItem[];
  readonly knowledge: readonly MarketplaceContextItem[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

/** A single recommendation emitted by a marketplace agent. */
export interface MarketplaceRecommendation {
  readonly agentId: string;
  readonly capability: string;
  readonly title: string;
  readonly recommendation: string;
  readonly urgency?: 'low' | 'medium' | 'high';
  readonly confidence?: number;
}

/** A sanitized, typed result for one marketplace agent section. */
export interface MarketplaceSection {
  readonly taskId?: string;
  readonly agentId: string;
  readonly capability: string;
  readonly status: 'success' | 'failure' | 'skipped';
  readonly output?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code: string; readonly message: string };
}

/** The final marketplace-facing result (always a string response + safe data). */
export interface MarketplaceResult {
  readonly marketplaceRequestId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly status: MarketplaceRequestStatus;
  readonly intent?: string;
  readonly routeKind?: 'single' | 'workflow';
  readonly agents: readonly string[];
  /** Human-readable final response — always present (Sprint 23 §15). */
  readonly response: string;
  readonly structuredData?: Readonly<Record<string, unknown>>;
  readonly recommendations?: readonly MarketplaceRecommendation[];
  readonly confidence?: number;
  readonly sections?: readonly MarketplaceSection[];
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

/** Safe aggregated output shape produced by the engagement-scope workflow. */
export interface MarketplaceWorkflowAggregate {
  readonly risk?: Readonly<Record<string, unknown>>;
  readonly milestones?: Readonly<Record<string, unknown>>;
  readonly contract?: Readonly<Record<string, unknown>>;
  readonly [taskId: string]: Readonly<Record<string, unknown>> | undefined;
}

/** A single executable step command produced by {@link MarketplaceAgentEngine}. */
export interface MarketplaceStepCommand {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly requiredTools?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly taskId?: string;
  readonly dependencies?: readonly string[];
  readonly timeoutMs?: number;
}
