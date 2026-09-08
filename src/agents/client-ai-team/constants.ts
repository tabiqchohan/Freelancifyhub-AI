/**
 * Sprint 21 — Client AI Team v1. Stable team, capability and route constants.
 *
 * The Client AI Team serves clients directly (project creation, editing,
 * viewing, deletion) and owns the supporting estimation/recommendation
 * capability slots (budget, timeline, skills, score). Values here are the
 * single source of truth shared by the router, workflows, platform mirrors
 * and diagnostics. AG-001's intent ids are authoritative: the router maps
 * them deterministically and never re-classifies user text itself.
 */

/** Team scope used by platform definitions of client-team agents. */
export const CLIENT_TEAM_GROUP = 'client';

/** Client AI Team agent slots. AG-101 is pre-registered by the runtime. */
export const CLIENT_AGENT_IDS = {
  projectDescription: 'AG-101',
  budgetEstimator: 'AG-102',
  timelineEstimator: 'AG-103',
  skillsRecommendation: 'AG-104',
  projectSuccessScore: 'AG-105',
} as const;

export type ClientAgentId = (typeof CLIENT_AGENT_IDS)[keyof typeof CLIENT_AGENT_IDS];

/** Agents this module introduces (AG-101 ships with the runtime already). */
export const CLIENT_NEW_AGENT_IDS: readonly ClientAgentId[] = [
  CLIENT_AGENT_IDS.budgetEstimator,
  CLIENT_AGENT_IDS.timelineEstimator,
  CLIENT_AGENT_IDS.skillsRecommendation,
  CLIENT_AGENT_IDS.projectSuccessScore,
];

/** Stable client-team capability ids (AG-001 `IntentId` compatible). */
export const CLIENT_CAPABILITY_IDS = {
  describe: 'project.read.describe',
  projectCreate: 'project.create',
  projectEdit: 'project.edit',
  projectView: 'project.view',
  projectDelete: 'project.delete',
  budgetEstimate: 'budget.estimate',
  timelineEstimate: 'timeline.estimate',
  skillsRecommend: 'skills.recommend',
  projectScore: 'project.score',
} as const;

/** Authoritative AG-004 tool allowed to client-team estimators (verify-first). */
export const CLIENT_CALCULATOR_TOOL = 'calculator';

/** AG-001 intents the client team owns, mapped to deterministic routes. */
export const CLIENT_INTENT_ROUTES: Readonly<
  Record<
    string,
    | { readonly kind: 'single'; readonly agentId: ClientAgentId; readonly capabilityId: string }
    | { readonly kind: 'workflow'; readonly workflowId: string }
  >
> = Object.freeze({
  'project.create': {
    kind: 'workflow',
    workflowId: 'client.project-creation',
  },
  'project.edit': {
    kind: 'single',
    agentId: CLIENT_AGENT_IDS.projectDescription,
    capabilityId: CLIENT_CAPABILITY_IDS.projectEdit,
  },
  'project.view': {
    kind: 'single',
    agentId: CLIENT_AGENT_IDS.projectDescription,
    capabilityId: CLIENT_CAPABILITY_IDS.projectView,
  },
  'project.delete': {
    kind: 'single',
    agentId: CLIENT_AGENT_IDS.projectDescription,
    capabilityId: CLIENT_CAPABILITY_IDS.projectDelete,
  },
});

/** Direct capability tasks this module serves (intent-less, deterministic). */
export const CLIENT_CAPABILITY_TARGETS: Readonly<
  Record<string, { readonly agentId: ClientAgentId; readonly capabilityId: string }>
> = Object.freeze({
  'budget.estimate': {
    agentId: CLIENT_AGENT_IDS.budgetEstimator,
    capabilityId: CLIENT_CAPABILITY_IDS.budgetEstimate,
  },
  'timeline.estimate': {
    agentId: CLIENT_AGENT_IDS.timelineEstimator,
    capabilityId: CLIENT_CAPABILITY_IDS.timelineEstimate,
  },
  'skills.recommend': {
    agentId: CLIENT_AGENT_IDS.skillsRecommendation,
    capabilityId: CLIENT_CAPABILITY_IDS.skillsRecommend,
  },
  'project.score': {
    agentId: CLIENT_AGENT_IDS.projectSuccessScore,
    capabilityId: CLIENT_CAPABILITY_IDS.projectScore,
  },
});

/** The single coordination workflow this sprint supports (project creation). */
export const CLIENT_PROJECT_CREATION_WORKFLOW = 'client.project-creation';

/** Supported client workflows (surface for `/api/client-ai/status`). */
export const CLIENT_WORKFLOW_IDS: readonly string[] = Object.freeze([
  CLIENT_PROJECT_CREATION_WORKFLOW,
]);

/** Task ids inside the project-creation workflow. */
export const CLIENT_WORKFLOW_TASK_IDS = Object.freeze({
  describe: 'describe',
  budget: 'budget',
  timeline: 'timeline',
  skills: 'skills',
});

/** Bounded context assembly (Sprint 21 §9 — never unbounded). */
export const CLIENT_CONTEXT_LIMITS = Object.freeze({
  maxMemoryItems: 5,
  maxKnowledgeDocs: 5,
  maxContextBytes: 16_384,
  maxBriefBytes: 8_192,
  maxStructuredBytes: 4_096,
});

/** Default coordination/execution limits for client workflows. */
export const CLIENT_DEFAULT_LIMITS = Object.freeze({
  defaultTaskTimeoutMs: 15_000,
  globalTimeoutMs: 30_000,
  maxTasks: 16,
  maxConcurrentTasks: 4,
  maxTasksPerAgent: 2,
  maxMessageBytes: 16_384,
});

/** Explicit minimum for every calculated budget range (catalog AC-BUD-*). */
export const CLIENT_MIN_BUDGET_USD = 50;

/** Conservative platform floor hourly rate; never a marketplace quote. */
export const CLIENT_FLOOR_HOURLY_RATE_USD = 25;

/** Working hours assumed for a single engineering week. */
export const CLIENT_HOURS_PER_WEEK = 40;

/** Module version shared by all client-team definitions. */
export const CLIENT_TEAM_VERSION = '1.0.0';
