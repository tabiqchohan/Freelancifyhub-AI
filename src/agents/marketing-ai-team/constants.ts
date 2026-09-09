/**
 * Sprint 24 — Marketing AI Team v1. Stable team, capability and route constants.
 *
 * The Marketing AI Team serves acquisition and retention workflows (research,
 * social content, blog content, SEO recommendations and email drafts) using the
 * exact catalog identities AG-401..AG-405 (docs/agent-catalog-v1.md §13).
 * Values here are the single source of truth shared by the router, workflows,
 * platform mirrors and diagnostics. AG-001's intent ids are authoritative: the
 * router maps them deterministically and never re-classifies user text itself.
 */

/** Team scope used by platform definitions of marketing-team agents. */
export const MARKETING_TEAM_GROUP = 'marketing';

/** Marketing AI Team agent slots (catalog §13 — exact architecture ids). */
export const MARKETING_AGENT_IDS = {
  research: 'AG-401',
  socialMedia: 'AG-402',
  blogWriter: 'AG-403',
  seoSpecialist: 'AG-404',
  emailMarketer: 'AG-405',
} as const;

export type MarketingAgentId = (typeof MARKETING_AGENT_IDS)[keyof typeof MARKETING_AGENT_IDS];

/** Agents this module introduces (all five). */
export const MARKETING_NEW_AGENT_IDS: readonly MarketingAgentId[] = [
  MARKETING_AGENT_IDS.research,
  MARKETING_AGENT_IDS.socialMedia,
  MARKETING_AGENT_IDS.blogWriter,
  MARKETING_AGENT_IDS.seoSpecialist,
  MARKETING_AGENT_IDS.emailMarketer,
];

/**
 * Stable marketing-team capability ids. Every id follows the orchestrator
 * `marketing.*` intent prefix (master-orchestrator-specification-v1.md §6) and
 * matches the AG-001 `IntentId` members the marketing team owns.
 */
export const MARKETING_CAPABILITY_IDS = {
  research: 'marketing.research',
  socialPost: 'marketing.post.draft',
  blogDraft: 'marketing.blog.draft',
  seoAnalyze: 'marketing.seo.analyze',
  emailDraft: 'marketing.email.draft',
} as const;

/** AG-001 intents the marketing team owns, mapped to deterministic routes. */
export const MARKETING_INTENT_ROUTES: Readonly<
  Record<
    string,
    | {
        readonly kind: 'single';
        readonly agentId: MarketingAgentId;
        readonly capabilityId: string;
      }
    | { readonly kind: 'workflow'; readonly workflowId: string }
  >
> = Object.freeze({
  'marketing.research': {
    kind: 'single',
    agentId: MARKETING_AGENT_IDS.research,
    capabilityId: MARKETING_CAPABILITY_IDS.research,
  },
  'marketing.social': {
    kind: 'single',
    agentId: MARKETING_AGENT_IDS.socialMedia,
    capabilityId: MARKETING_CAPABILITY_IDS.socialPost,
  },
  'marketing.blog': {
    kind: 'single',
    agentId: MARKETING_AGENT_IDS.blogWriter,
    capabilityId: MARKETING_CAPABILITY_IDS.blogDraft,
  },
  'marketing.seo': {
    kind: 'single',
    agentId: MARKETING_AGENT_IDS.seoSpecialist,
    capabilityId: MARKETING_CAPABILITY_IDS.seoAnalyze,
  },
  'marketing.email': {
    kind: 'single',
    agentId: MARKETING_AGENT_IDS.emailMarketer,
    capabilityId: MARKETING_CAPABILITY_IDS.emailDraft,
  },
  'marketing.campaign': {
    kind: 'workflow',
    workflowId: 'marketing.campaign',
  },
});

/**
 * Direct capability tasks this module serves (intent-less, deterministic).
 * Every capability maps to its catalog agent so platform admission stays
 * authoritative while the agent itself stays fully deterministic.
 */
export const MARKETING_CAPABILITY_TARGETS: Readonly<
  Record<string, { readonly agentId: MarketingAgentId; readonly capabilityId: string }>
> = Object.freeze({
  'marketing.research': {
    agentId: MARKETING_AGENT_IDS.research,
    capabilityId: MARKETING_CAPABILITY_IDS.research,
  },
  'marketing.post.draft': {
    agentId: MARKETING_AGENT_IDS.socialMedia,
    capabilityId: MARKETING_CAPABILITY_IDS.socialPost,
  },
  'marketing.blog.draft': {
    agentId: MARKETING_AGENT_IDS.blogWriter,
    capabilityId: MARKETING_CAPABILITY_IDS.blogDraft,
  },
  'marketing.seo.analyze': {
    agentId: MARKETING_AGENT_IDS.seoSpecialist,
    capabilityId: MARKETING_CAPABILITY_IDS.seoAnalyze,
  },
  'marketing.email.draft': {
    agentId: MARKETING_AGENT_IDS.emailMarketer,
    capabilityId: MARKETING_CAPABILITY_IDS.emailDraft,
  },
});

/** The coordination workflow this sprint ships (campaign content planning). */
export const MARKETING_CAMPAIGN_WORKFLOW = 'marketing.campaign';

/** Supported marketing workflows (surface for `/api/marketing-ai/status`). */
export const MARKETING_WORKFLOW_IDS: readonly string[] = Object.freeze([
  MARKETING_CAMPAIGN_WORKFLOW,
]);

/** Task ids inside the campaign workflow. */
export const MARKETING_WORKFLOW_TASK_IDS = Object.freeze({
  research: 'research',
  social: 'social',
  email: 'email',
});

/** Bounded context assembly (Sprint 24 §7 — never unbounded). */
export const MARKETING_CONTEXT_LIMITS = Object.freeze({
  maxMemoryItems: 5,
  maxKnowledgeDocs: 5,
  maxContextBytes: 16_384,
  maxBriefBytes: 8_192,
  maxStructuredBytes: 4_096,
});

/** Default coordination/execution limits for marketing workflows. */
export const MARKETING_DEFAULT_LIMITS = Object.freeze({
  defaultTaskTimeoutMs: 15_000,
  globalTimeoutMs: 30_000,
  maxTasks: 16,
  maxConcurrentTasks: 4,
  maxTasksPerAgent: 2,
  maxMessageBytes: 16_384,
});

/** A campaign/content document must stay within a bounded size. */
export const MARKETING_MAX_DOCUMENT_BYTES = 16_384;

/** Maximum research sources analyzed in a single request. */
export const MARKETING_MAX_SOURCES = 20;

/** Maximum keywords analyzed in a single SEO request. */
export const MARKETING_MAX_KEYWORDS = 20;

/** Maximum headings analyzed in a single SEO request. */
export const MARKETING_MAX_HEADINGS = 20;

/** Maximum number of content variants a social post agent may produce. */
export const MARKETING_MAX_SOCIAL_VARIANTS = 4;

/**
 * Per-platform character budgets used for deterministic social draft bounds.
 * Budgets are edited-for-context approximations treated as guidelines, never
 * as observed platform statistics (data-honesty rule, Sprint 24 §13).
 */
export const MARKETING_PLATFORM_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  linkedin: 3_000,
  x: 280,
  instagram: 2_200,
  facebook: 5_000,
});

/** Module version shared by all marketing-team definitions. */
export const MARKETING_TEAM_VERSION = '1.0.0';
