/**
 * Sprint 22 — Freelancer AI Team v1. Domain contracts.
 *
 * Every value crossing the Freelancer AI boundary is typed, bounded and
 * secret-free. `FreelancerRequest` is the validated service input (the
 * serializable portion is schema-validated; `cancellation` is re-attached
 * after parsing). `FreelancerResult` is the final freelancer-facing contract:
 * a string response plus safe structured data. Deterministic agents consume
 * structured input only and never fabricate facts (Sprint 22 §9/§12).
 */

import type { ExecutionError } from '../ag-001-master-orchestrator/execution/index.js';

export type { ExecutionError };

/** Status of a completed freelancer-AI request. */
export type FreelancerRequestStatus =
  'COMPLETED' | 'COMPLETED_PARTIAL' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

/** Cooperative cancellation handle propagated to executions. */
export interface FreelancerCancellation {
  readonly requested: boolean;
  readonly signal: AbortSignal;
}

/** Freelancer/user scope used for AG-002/AG-003/AG-004 authorization. */
export interface FreelancerActor {
  readonly actorId: string;
  /** Explicit namespace allow-list (fail-closed when empty). */
  readonly namespaces: readonly string[];
  readonly role?: string;
  readonly securityClearance?: string;
  readonly availability?: string;
}

/** A freelancer's declared profile (deterministic analysis input). */
export interface FreelancerProfile {
  readonly headline?: string;
  readonly bio?: string;
  readonly skills?: readonly string[];
  readonly experience?: { readonly years?: number };
  readonly portfolioUrl?: string;
  readonly hourlyRate?: number;
  readonly availability?: string;
  readonly location?: string;
}

/** A project under evaluation for matches/proposals (match + proposal input). */
export interface FreelancerProject {
  readonly title?: string;
  readonly description?: string;
  readonly requirements?: readonly string[];
  readonly requiredSkills?: readonly string[];
  readonly category?: string;
  readonly budget?: { readonly min?: number; readonly max?: number };
  readonly timeline?: { readonly weeksMin?: number; readonly weeksMax?: number };
}

/** Bounded activity signals for the career-insight agent (nothing fabricated). */
export interface FreelancerActivity {
  readonly proposalsCount?: number;
  readonly projectsCompleted?: number;
  readonly ongoingProjects?: number;
  readonly totalEarnings?: number;
  readonly averageRating?: number;
  readonly reviewCount?: number;
  readonly onTimeDeliveryRate?: number;
}

/** Structured input accepted by the service (bounded by validation). */
export interface FreelancerRequestInput {
  readonly profile?: FreelancerProfile;
  readonly project?: FreelancerProject;
  readonly activity?: FreelancerActivity;
  /** A user-provided starting draft; analysed, never fabricated (AG-201). */
  readonly proposalDraft?: string;
  readonly [key: string]: unknown;
}

/** A direct capability task (takes precedence over intent when provided). */
export interface FreelancerTaskSpec {
  readonly capabilityId: string;
  readonly agentId?: string;
  readonly objective?: string;
  readonly requiredTools?: readonly string[];
  readonly toolCalls?: readonly { readonly name: string; readonly input: unknown }[];
  readonly mode?: 'single' | 'agentic';
}

/** A validated freelancer-AI request. */
export interface FreelancerRequest {
  readonly freelancerRequestId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  /** AG-001 detected intent id — authoritative for routing. */
  readonly intent?: string;
  readonly task?: FreelancerTaskSpec;
  /** Structured, bounded input (profile/project/activity/draft). */
  readonly input: FreelancerRequestInput;
  readonly actor: FreelancerActor;
  readonly limits?: { readonly timeoutMs?: number; readonly globalTimeoutMs?: number };
  readonly cancellation?: FreelancerCancellation;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The deterministic route selected for a validated request. */
export type FreelancerRoute =
  | { readonly kind: 'single'; readonly agentId: string; readonly capabilityId: string }
  | { readonly kind: 'workflow'; readonly workflowId: string };

/** A bounded, sanitized context item delivered to a freelancer agent. */
export interface FreelancerContextItem {
  readonly id: string;
  readonly namespace: string;
  readonly key: string;
  readonly content: string;
  readonly source: string;
}

/** Bounded, sanitized request context (memory + knowledge, deduplicated). */
export interface FreelancerContext {
  readonly memory: readonly FreelancerContextItem[];
  readonly knowledge: readonly FreelancerContextItem[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

/** A single recommendation emitted by a freelancer agent. */
export interface FreelancerRecommendation {
  readonly agentId: string;
  readonly capability: string;
  readonly title: string;
  readonly recommendation: string;
  readonly urgency?: 'low' | 'medium' | 'high';
  readonly confidence?: number;
}

/** A sanitized, typed result for one freelancer agent section. */
export interface FreelancerSection {
  readonly taskId?: string;
  readonly agentId: string;
  readonly capability: string;
  readonly status: 'success' | 'failure' | 'skipped';
  readonly output?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code: string; readonly message: string };
}

/** The final freelancer-facing result (always a string response + safe data). */
export interface FreelancerResult {
  readonly freelancerRequestId: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly status: FreelancerRequestStatus;
  readonly intent?: string;
  readonly routeKind?: 'single' | 'workflow';
  readonly agents: readonly string[];
  /** Human-readable final response — always present (Sprint 22 §15). */
  readonly response: string;
  readonly structuredData?: Readonly<Record<string, unknown>>;
  readonly recommendations?: readonly FreelancerRecommendation[];
  readonly confidence?: number;
  readonly sections?: readonly FreelancerSection[];
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

/** Safe aggregated output shape produced by the proposal-draft workflow. */
export interface FreelancerWorkflowAggregate {
  readonly profile?: Readonly<Record<string, unknown>>;
  readonly match?: Readonly<Record<string, unknown>>;
  readonly proposal?: Readonly<Record<string, unknown>>;
  readonly [taskId: string]: Readonly<Record<string, unknown>> | undefined;
}

/** A single executable step command produced by {@link FreelancerAgentEngine}. */
export interface FreelancerStepCommand {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly requiredTools?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly taskId?: string;
  readonly dependencies?: readonly string[];
  readonly timeoutMs?: number;
}
