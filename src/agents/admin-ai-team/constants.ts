/**
 * Sprint 25 — Admin AI Team v1. Stable team, capability, scope and route
 * constants.
 *
 * The Admin AI Team serves privileged platform workflows (analytics, fraud
 * triage, platform health, AI operations and executive insights) using the
 * exact catalog identities AG-501..AG-505 (docs/agent-catalog-v1.md §14).
 * Values here are the single source of truth shared by the router, workflows,
 * authorization layer, platform mirrors and diagnostics. AG-001's intent ids
 * are authoritative: the router maps them deterministically and never
 * re-classifies user text itself.
 */

/** Team scope used by platform definitions of admin-team agents. */
export const ADMIN_TEAM_GROUP = 'admin';

/** Admin AI Team agent slots (catalog §14 — exact architecture ids). */
export const ADMIN_AGENT_IDS = {
  analytics: 'AG-501',
  fraudMonitoring: 'AG-502',
  platformHealth: 'AG-503',
  aiOperations: 'AG-504',
  executive: 'AG-505',
} as const;

export type AdminAgentId = (typeof ADMIN_AGENT_IDS)[keyof typeof ADMIN_AGENT_IDS];

/** Agents this module introduces (all five). */
export const ADMIN_NEW_AGENT_IDS: readonly AdminAgentId[] = [
  ADMIN_AGENT_IDS.analytics,
  ADMIN_AGENT_IDS.fraudMonitoring,
  ADMIN_AGENT_IDS.platformHealth,
  ADMIN_AGENT_IDS.aiOperations,
  ADMIN_AGENT_IDS.executive,
];

/**
 * Stable admin-team capability ids. Every id follows the orchestrator
 * `admin.*` intent prefix (master-orchestrator-specification-v1.md §6) with the
 * exception of `admin.action` which already existed as the generic
 * administrative capability on AG-501. No privileged capability is invented
 * beyond the catalog (prompt §4, agent-catalog-v1.md §14).
 */
export const ADMIN_CAPABILITY_IDS = {
  action: 'admin.action',
  analytics: 'admin.analytics',
  fraud: 'admin.fraud',
  health: 'admin.health',
  aiOps: 'admin.aiops',
  executive: 'admin.executive',
} as const;

/** The coordination workflow this sprint ships (executive review fan-out). */
export const ADMIN_EXECUTIVE_WORKFLOW = 'admin.executive';

/** AG-001 intents the admin team owns, mapped to deterministic routes. */
export const ADMIN_INTENT_ROUTES: Readonly<
  Record<
    string,
    | {
        readonly kind: 'single';
        readonly agentId: AdminAgentId;
        readonly capabilityId: string;
      }
    | { readonly kind: 'workflow'; readonly workflowId: string }
  >
> = Object.freeze({
  'admin.action': {
    kind: 'single',
    agentId: ADMIN_AGENT_IDS.analytics,
    capabilityId: ADMIN_CAPABILITY_IDS.action,
  },
  'admin.analytics': {
    kind: 'single',
    agentId: ADMIN_AGENT_IDS.analytics,
    capabilityId: ADMIN_CAPABILITY_IDS.analytics,
  },
  'admin.fraud': {
    kind: 'single',
    agentId: ADMIN_AGENT_IDS.fraudMonitoring,
    capabilityId: ADMIN_CAPABILITY_IDS.fraud,
  },
  'admin.health': {
    kind: 'single',
    agentId: ADMIN_AGENT_IDS.platformHealth,
    capabilityId: ADMIN_CAPABILITY_IDS.health,
  },
  'admin.aiops': {
    kind: 'single',
    agentId: ADMIN_AGENT_IDS.aiOperations,
    capabilityId: ADMIN_CAPABILITY_IDS.aiOps,
  },
  'admin.executive': {
    kind: 'workflow',
    workflowId: ADMIN_EXECUTIVE_WORKFLOW,
  },
});

/**
 * Direct capability tasks this module serves (intent-less, deterministic).
 * Every capability maps to its catalog agent so platform admission stays
 * authoritative while the agent itself stays fully deterministic.
 */
export const ADMIN_CAPABILITY_TARGETS: Readonly<
  Record<string, { readonly agentId: AdminAgentId; readonly capabilityId: string }>
> = Object.freeze({
  'admin.action': {
    agentId: ADMIN_AGENT_IDS.analytics,
    capabilityId: ADMIN_CAPABILITY_IDS.action,
  },
  'admin.analytics': {
    agentId: ADMIN_AGENT_IDS.analytics,
    capabilityId: ADMIN_CAPABILITY_IDS.analytics,
  },
  'admin.fraud': {
    agentId: ADMIN_AGENT_IDS.fraudMonitoring,
    capabilityId: ADMIN_CAPABILITY_IDS.fraud,
  },
  'admin.health': {
    agentId: ADMIN_AGENT_IDS.platformHealth,
    capabilityId: ADMIN_CAPABILITY_IDS.health,
  },
  'admin.aiops': {
    agentId: ADMIN_AGENT_IDS.aiOperations,
    capabilityId: ADMIN_CAPABILITY_IDS.aiOps,
  },
  'admin.executive': {
    agentId: ADMIN_AGENT_IDS.executive,
    capabilityId: ADMIN_CAPABILITY_IDS.executive,
  },
});

/** Supported admin workflows (surface for `/api/admin-ai/status`). */
export const ADMIN_WORKFLOW_IDS: readonly string[] = Object.freeze([ADMIN_EXECUTIVE_WORKFLOW]);

/** Task ids inside the executive workflow. */
export const ADMIN_WORKFLOW_TASK_IDS = Object.freeze({
  analytics: 'analytics',
  health: 'health',
  fraud: 'fraud',
});

/**
 * Role scopes an admin may act within (BR-ADM-1: users/projects/payments/
 * disputes/fraud/AI). Every privileged capability requires an explicit scope
 * allow-list on the actor; a missing scope fails closed.
 */
export const ADMIN_SCOPES = Object.freeze([
  'users',
  'projects',
  'payments',
  'disputes',
  'fraud',
  'ai',
] as const);

export type AdminScope = (typeof ADMIN_SCOPES)[number];

/** Role value that grants admin-team authorization. */
export const ADMIN_ROLE = 'Admin';

/** Bounded context assembly (Sprint 25 §8 — never unbounded). */
export const ADMIN_CONTEXT_LIMITS = Object.freeze({
  maxMemoryItems: 5,
  maxKnowledgeDocs: 5,
  maxContextBytes: 16_384,
  maxBriefBytes: 8_192,
  maxStructuredBytes: 4_096,
});

/** Default coordination/execution limits for admin workflows. */
export const ADMIN_DEFAULT_LIMITS = Object.freeze({
  defaultTaskTimeoutMs: 15_000,
  globalTimeoutMs: 30_000,
  maxTasks: 16,
  maxConcurrentTasks: 4,
  maxTasksPerAgent: 2,
  maxMessageBytes: 16_384,
});

/** A privileged document / report must stay within a bounded size. */
export const ADMIN_MAX_DOCUMENT_BYTES = 16_384;

/** Maximum fraud signals analyzed in a single request. */
export const ADMIN_MAX_SIGNALS = 20;

/** Maximum analytics query bytes accepted by the analytics agent. */
export const ADMIN_MAX_QUERY_BYTES = 2_048;

/** Maximum health metrics reported in a single request. */
export const ADMIN_MAX_METRICS = 20;

/** Maximum KPI facts accepted by the executive insights agent. */
export const ADMIN_MAX_KPIS = 20;

/** Maximum number of runtime approvals referenced by one report. */
export const ADMIN_MAX_APPROVAL_REFERENCES = 8;

/** Module version shared by all admin-team definitions. */
export const ADMIN_TEAM_VERSION = '1.0.0';
