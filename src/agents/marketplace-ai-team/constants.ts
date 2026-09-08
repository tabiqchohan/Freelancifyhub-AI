/**
 * Sprint 23 — Marketplace AI Team v1. Stable team, capability and route constants.
 *
 * The Marketplace AI Team serves the marketplace itself (project discovery,
 * matching, project quality, budget intelligence, insights and opportunity
 * analysis) plus the trust/commerce rail (contracts, milestones, reviews,
 * scam detection, disputes, messaging) using the exact catalog identities
 * AG-301..AG-306 (docs/agent-catalog-v1.md §12). Values here are the single
 * source of truth shared by the router, workflows, platform mirrors and
 * diagnostics. AG-001's intent ids are authoritative: the router maps them
 * deterministically and never re-classifies user text itself.
 */

/** Team scope used by platform definitions of marketplace-team agents. */
export const MARKETPLACE_TEAM_GROUP = 'marketplace';

/** Marketplace AI Team agent slots (catalog §12 — exact architecture ids). */
export const MARKETPLACE_AGENT_IDS = {
  contractGenerator: 'AG-301',
  milestonePlanner: 'AG-302',
  reviewGenerator: 'AG-303',
  scamDetector: 'AG-304',
  disputeAssistant: 'AG-305',
  messagingAssistant: 'AG-306',
} as const;

export type MarketplaceAgentId = (typeof MARKETPLACE_AGENT_IDS)[keyof typeof MARKETPLACE_AGENT_IDS];

/** Agents this module introduces (all six). */
export const MARKETPLACE_NEW_AGENT_IDS: readonly MarketplaceAgentId[] = [
  MARKETPLACE_AGENT_IDS.contractGenerator,
  MARKETPLACE_AGENT_IDS.milestonePlanner,
  MARKETPLACE_AGENT_IDS.reviewGenerator,
  MARKETPLACE_AGENT_IDS.scamDetector,
  MARKETPLACE_AGENT_IDS.disputeAssistant,
  MARKETPLACE_AGENT_IDS.messagingAssistant,
];

/**
 * Stable marketplace-team capability ids. The six primary ids match AG-001
 * `IntentId` members; the four intelligence ids are direct-task capabilities
 * served by the marketplace analytics layer (no AG-001 intent exists yet).
 */
export const MARKETPLACE_CAPABILITY_IDS = {
  contractGenerate: 'contract.generate',
  milestonePlan: 'milestone.plan',
  reviewGenerate: 'review.generate',
  scamReport: 'scam.report',
  disputeOpen: 'dispute.open',
  messageSend: 'message.send',
  projectQuality: 'project.quality',
  opportunityAnalyze: 'opportunity.analyze',
  budgetAnalyze: 'budget.analyze',
  marketplaceInsights: 'marketplace.insights',
  marketplaceDiscovery: 'marketplace.discovery',
  engagementScope: 'engagement.scope',
} as const;

/** AG-001 intents the marketplace team owns, mapped to deterministic routes. */
export const MARKETPLACE_INTENT_ROUTES: Readonly<
  Record<
    string,
    | {
        readonly kind: 'single';
        readonly agentId: MarketplaceAgentId;
        readonly capabilityId: string;
      }
    | { readonly kind: 'workflow'; readonly workflowId: string }
  >
> = Object.freeze({
  'contract.generate': {
    kind: 'single',
    agentId: MARKETPLACE_AGENT_IDS.contractGenerator,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.contractGenerate,
  },
  'milestone.plan': {
    kind: 'single',
    agentId: MARKETPLACE_AGENT_IDS.milestonePlanner,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.milestonePlan,
  },
  'review.generate': {
    kind: 'single',
    agentId: MARKETPLACE_AGENT_IDS.reviewGenerator,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.reviewGenerate,
  },
  'scam.report': {
    kind: 'single',
    agentId: MARKETPLACE_AGENT_IDS.scamDetector,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.scamReport,
  },
  'dispute.open': {
    kind: 'single',
    agentId: MARKETPLACE_AGENT_IDS.disputeAssistant,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.disputeOpen,
  },
  'message.send': {
    kind: 'single',
    agentId: MARKETPLACE_AGENT_IDS.messagingAssistant,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.messageSend,
  },
  'engagement.scope': {
    kind: 'workflow',
    workflowId: 'marketplace.engagement-scope',
  },
});

/**
 * Direct capability tasks this module serves (intent-less, deterministic).
 * Every intelligence capability maps to the closest catalog agent so platform
 * admission stays authoritative while the analytics layer stays fully
 * deterministic.
 */
export const MARKETPLACE_CAPABILITY_TARGETS: Readonly<
  Record<string, { readonly agentId: MarketplaceAgentId; readonly capabilityId: string }>
> = Object.freeze({
  'contract.generate': {
    agentId: MARKETPLACE_AGENT_IDS.contractGenerator,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.contractGenerate,
  },
  'project.quality': {
    agentId: MARKETPLACE_AGENT_IDS.contractGenerator,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.projectQuality,
  },
  'opportunity.analyze': {
    agentId: MARKETPLACE_AGENT_IDS.contractGenerator,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.opportunityAnalyze,
  },
  'milestone.plan': {
    agentId: MARKETPLACE_AGENT_IDS.milestonePlanner,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.milestonePlan,
  },
  'budget.analyze': {
    agentId: MARKETPLACE_AGENT_IDS.milestonePlanner,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.budgetAnalyze,
  },
  'review.generate': {
    agentId: MARKETPLACE_AGENT_IDS.reviewGenerator,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.reviewGenerate,
  },
  'scam.report': {
    agentId: MARKETPLACE_AGENT_IDS.scamDetector,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.scamReport,
  },
  'marketplace.insights': {
    agentId: MARKETPLACE_AGENT_IDS.scamDetector,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.marketplaceInsights,
  },
  'marketplace.discovery': {
    agentId: MARKETPLACE_AGENT_IDS.scamDetector,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.marketplaceDiscovery,
  },
  'dispute.open': {
    agentId: MARKETPLACE_AGENT_IDS.disputeAssistant,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.disputeOpen,
  },
  'message.send': {
    agentId: MARKETPLACE_AGENT_IDS.messagingAssistant,
    capabilityId: MARKETPLACE_CAPABILITY_IDS.messageSend,
  },
});

/** The coordination workflow this sprint ships (engagement scoping). */
export const MARKETPLACE_ENGAGEMENT_WORKFLOW = 'marketplace.engagement-scope';

/** Supported marketplace workflows (surface for `/api/marketplace-ai/status`). */
export const MARKETPLACE_WORKFLOW_IDS: readonly string[] = Object.freeze([
  MARKETPLACE_ENGAGEMENT_WORKFLOW,
]);

/** Task ids inside the engagement-scope workflow. */
export const MARKETPLACE_WORKFLOW_TASK_IDS = Object.freeze({
  risk: 'risk',
  milestones: 'milestones',
  contract: 'contract',
});

/** Bounded context assembly (Sprint 23 §24 — never unbounded). */
export const MARKETPLACE_CONTEXT_LIMITS = Object.freeze({
  maxMemoryItems: 5,
  maxKnowledgeDocs: 5,
  maxContextBytes: 16_384,
  maxBriefBytes: 8_192,
  maxStructuredBytes: 4_096,
});

/** Default coordination/execution limits for marketplace workflows. */
export const MARKETPLACE_DEFAULT_LIMITS = Object.freeze({
  defaultTaskTimeoutMs: 15_000,
  globalTimeoutMs: 30_000,
  maxTasks: 16,
  maxConcurrentTasks: 4,
  maxTasksPerAgent: 2,
  maxMessageBytes: 16_384,
});

/** A contract/review document must stay within a bounded size. */
export const MARKETPLACE_MAX_DOCUMENT_BYTES = 16_384;

/** Maximum number of requirements/skills analyzed in a single request. */
export const MARKETPLACE_MAX_REQUIREMENTS = 20;

/** Maximum number of projects ranked during discovery/insights in one call. */
export const MARKETPLACE_MAX_PROJECTS = 25;

/** Minimum number of projects before observed metrics are reported. */
export const MARKETPLACE_MIN_PROJECTS_FOR_METRICS = 3;

/** Minimum skills before a freelancer counts as "skills complete". */
export const MARKETPLACE_MIN_SKILLS_FOR_COMPLETE = 3;

/** Module version shared by all marketplace-team definitions. */
export const MARKETPLACE_TEAM_VERSION = '1.0.0';
