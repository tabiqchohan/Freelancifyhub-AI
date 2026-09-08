/**
 * Sprint 22 — Freelancer AI Team v1. Stable team, capability and route constants.
 *
 * The Freelancer AI Team serves freelancers directly (profile optimization,
 * proposal generation, project matching and career insights) using the exact
 * catalog identities AG-201/AG-202/AG-206/AG-207 (docs/agent-catalog-v1.md §11).
 * Values here are the single source of truth shared by the router, workflows,
 * platform mirrors and diagnostics. AG-001's intent ids are authoritative: the
 * router maps them deterministically and never re-classifies user text itself.
 */

/** Team scope used by platform definitions of freelancer-team agents. */
export const FREELANCER_TEAM_GROUP = 'freelancer';

/** Freelancer AI Team agent slots (catalog §11 — exact architecture ids). */
export const FREELANCER_AGENT_IDS = {
  proposalWriter: 'AG-201',
  profileOptimizer: 'AG-202',
  projectRecommendation: 'AG-206',
  careerAdvisor: 'AG-207',
} as const;

export type FreelancerAgentId = (typeof FREELANCER_AGENT_IDS)[keyof typeof FREELANCER_AGENT_IDS];

/** Agents this module introduces (all four). */
export const FREELANCER_NEW_AGENT_IDS: readonly FreelancerAgentId[] = [
  FREELANCER_AGENT_IDS.proposalWriter,
  FREELANCER_AGENT_IDS.profileOptimizer,
  FREELANCER_AGENT_IDS.projectRecommendation,
  FREELANCER_AGENT_IDS.careerAdvisor,
];

/** Stable freelancer-team capability ids (AG-001 `IntentId` compatible). */
export const FREELANCER_CAPABILITY_IDS = {
  profileAnalyze: 'profile.analyze',
  proposalDraft: 'proposal.draft',
  projectMatch: 'project.match',
  insightAnalyze: 'insight.analyze',
} as const;

/** AG-001 intents the freelancer team owns, mapped to deterministic routes. */
export const FREELANCER_INTENT_ROUTES: Readonly<
  Record<
    string,
    | {
        readonly kind: 'single';
        readonly agentId: FreelancerAgentId;
        readonly capabilityId: string;
      }
    | { readonly kind: 'workflow'; readonly workflowId: string }
  >
> = Object.freeze({
  'profile.optimize': {
    kind: 'single',
    agentId: FREELANCER_AGENT_IDS.profileOptimizer,
    capabilityId: FREELANCER_CAPABILITY_IDS.profileAnalyze,
  },
  'proposal.generate': {
    kind: 'workflow',
    workflowId: 'freelancer.proposal-draft',
  },
  'project.match': {
    kind: 'single',
    agentId: FREELANCER_AGENT_IDS.projectRecommendation,
    capabilityId: FREELANCER_CAPABILITY_IDS.projectMatch,
  },
  'career.advice': {
    kind: 'single',
    agentId: FREELANCER_AGENT_IDS.careerAdvisor,
    capabilityId: FREELANCER_CAPABILITY_IDS.insightAnalyze,
  },
});

/** Direct capability tasks this module serves (intent-less, deterministic). */
export const FREELANCER_CAPABILITY_TARGETS: Readonly<
  Record<string, { readonly agentId: FreelancerAgentId; readonly capabilityId: string }>
> = Object.freeze({
  'profile.analyze': {
    agentId: FREELANCER_AGENT_IDS.profileOptimizer,
    capabilityId: FREELANCER_CAPABILITY_IDS.profileAnalyze,
  },
  'proposal.draft': {
    agentId: FREELANCER_AGENT_IDS.proposalWriter,
    capabilityId: FREELANCER_CAPABILITY_IDS.proposalDraft,
  },
  'project.match': {
    agentId: FREELANCER_AGENT_IDS.projectRecommendation,
    capabilityId: FREELANCER_CAPABILITY_IDS.projectMatch,
  },
  'insight.analyze': {
    agentId: FREELANCER_AGENT_IDS.careerAdvisor,
    capabilityId: FREELANCER_CAPABILITY_IDS.insightAnalyze,
  },
});

/** The single coordination workflow this sprint ships (proposal generation). */
export const FREELANCER_PROPOSAL_WORKFLOW = 'freelancer.proposal-draft';

/** Supported freelancer workflows (surface for `/api/freelancer-ai/status`). */
export const FREELANCER_WORKFLOW_IDS: readonly string[] = Object.freeze([
  FREELANCER_PROPOSAL_WORKFLOW,
]);

/** Task ids inside the proposal-draft workflow. */
export const FREELANCER_WORKFLOW_TASK_IDS = Object.freeze({
  profile: 'profile',
  match: 'match',
  proposal: 'proposal',
});

/** Bounded context assembly (Sprint 22 §6 — never unbounded). */
export const FREELANCER_CONTEXT_LIMITS = Object.freeze({
  maxMemoryItems: 5,
  maxKnowledgeDocs: 5,
  maxContextBytes: 16_384,
  maxBriefBytes: 8_192,
  maxStructuredBytes: 4_096,
});

/** Default coordination/execution limits for freelancer workflows. */
export const FREELANCER_DEFAULT_LIMITS = Object.freeze({
  defaultTaskTimeoutMs: 15_000,
  globalTimeoutMs: 30_000,
  maxTasks: 16,
  maxConcurrentTasks: 4,
  maxTasksPerAgent: 2,
  maxMessageBytes: 16_384,
});

/** A proposal draft must stay within a bounded document size. */
export const FREELANCER_MAX_DRAFT_BYTES = 16_384;

/** Maximum number of requirements/skills analyzed in a single request. */
export const FREELANCER_MAX_REQUIREMENTS = 20;

/** Minimum skills before a profile counts as "skills complete". */
export const FREELANCER_MIN_SKILLS_FOR_COMPLETE = 3;

/** Module version shared by all freelancer-team definitions. */
export const FREELANCER_TEAM_VERSION = '1.0.0';
