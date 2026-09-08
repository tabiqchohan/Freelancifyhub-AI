/**
 * Sprint 21 — Client AI Team v1. Deterministic client agents (AG-102..AG-105).
 *
 * Every client agent is deterministic-first: it computes from its inputs and
 * the provided context and never requires an LLM. Calculated values are
 * explicitly labelled (never inventing marketplace prices — catalog AC-06 and
 * the §17 transparency rule). Tool results and memory/knowledge context are
 * treated as data. Cancellation is cooperative through the runtime signal.
 */

import type { AgentCapability } from '../ag-001-master-orchestrator/interfaces/index.js';
import {
  AgentCategory,
  AgentStatus,
  DependencyType,
} from '../ag-001-master-orchestrator/types/index.js';
import type {
  RuntimeAgent,
  RuntimeAgentExecutionContext,
  RuntimeAgentExecutionResult,
} from '../runtime/types.js';
import type { AgentDefinition } from '../agent-platform/types.js';
import { AgentExecutionMode, capability } from '../agent-platform/index.js';
import {
  CLIENT_AGENT_IDS,
  CLIENT_CALCULATOR_TOOL,
  CLIENT_CAPABILITY_IDS,
  CLIENT_FLOOR_HOURLY_RATE_USD,
  CLIENT_HOURS_PER_WEEK,
  CLIENT_MIN_BUDGET_USD,
  CLIENT_TEAM_VERSION,
} from './constants.js';
import { sanitizeClientText } from './security.js';

/** A skill from the fixed client taxonomy (catalog AC-06 — taxonomy only). */
export interface ClientSkill {
  readonly id: string;
  readonly label: string;
  readonly keywords: readonly string[];
}

/** The fixed, catalog-backed skills taxonomy the client team may recommend. */
export const CLIENT_SKILL_TAXONOMY: readonly ClientSkill[] = Object.freeze([
  {
    id: 'web-development',
    label: 'Web Development',
    keywords: [
      'website',
      'web app',
      'webapp',
      'frontend',
      'backend',
      'full-stack',
      'react',
      'next',
    ],
  },
  {
    id: 'mobile-development',
    label: 'Mobile Development',
    keywords: ['mobile app', 'android', 'ios', 'react native', 'flutter', 'swift', 'kotlin'],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    keywords: ['typescript', 'ts ', 'node', 'javascript', 'js '],
  },
  {
    id: 'python',
    label: 'Python',
    keywords: ['python', 'django', 'flask', 'fastapi', 'pandas', 'scikit'],
  },
  {
    id: 'data-analysis',
    label: 'Data Analysis',
    keywords: ['data', 'analytics', 'analysis', 'dashboard', 'reporting', 'sql'],
  },
  {
    id: 'ui-ux-design',
    label: 'UI/UX Design',
    keywords: ['ui', 'ux', 'design', 'figma', 'wireframe', 'prototype', 'user experience'],
  },
  {
    id: 'content-writing',
    label: 'Content Writing',
    keywords: ['content', 'writing', 'copy', 'blog', 'article', 'seo copy'],
  },
  {
    id: 'digital-marketing',
    label: 'Digital Marketing',
    keywords: ['marketing', 'seo', 'campaign', 'ads', 'social media', 'brand'],
  },
  {
    id: 'devops',
    label: 'DevOps',
    keywords: ['devops', 'deploy', 'ci/cd', 'aws', 'docker', 'kubernetes', 'infrastructure'],
  },
  {
    id: 'e-commerce',
    label: 'E-Commerce',
    keywords: ['ecommerce', 'e-commerce', 'shop', 'store', 'checkout', 'cart'],
  },
  {
    id: 'qa-testing',
    label: 'QA & Testing',
    keywords: ['qa', 'testing', 'test', 'bug', 'quality'],
  },
  {
    id: 'automation',
    label: 'Automation',
    keywords: ['automation', 'script', 'workflow', 'integration', 'api'],
  },
]);

/** Structured fields extracted from a client task input (never invented). */
export interface ClientStructuredInput {
  readonly brief: string;
  readonly headline?: string;
  readonly requirements: readonly string[];
  readonly budget?: { readonly min?: number; readonly max?: number };
  readonly timeline?: { readonly weeksMin?: number; readonly weeksMax?: number };
  readonly skills: readonly string[];
  readonly durationHours?: number;
}

/** Extracts structured input from arbitrary execution inputs. */
export function extractStructuredInput(
  inputs: Readonly<Record<string, unknown>>,
): ClientStructuredInput {
  const inline = (inputs['input'] as Readonly<Record<string, unknown>> | undefined) ?? inputs;
  const brief =
    asString(inputs['brief']) ??
    (typeof inputs['request.input'] === 'string' ? (inputs['request.input'] as string) : '') ??
    asString(inline['brief']);
  return {
    brief: sanitizeClientText(brief, 8_192),
    headline: asString(inputs['headline']) ?? asString(inline['headline']),
    requirements:
      asStringArray(inputs['requirements']) ?? asStringArray(inline['requirements']) ?? [],
    budget: asObject(inline['budget']),
    timeline: asObject(inline['timeline']),
    skills: asStringArray(inline['skills']) ?? [],
    durationHours: asFiniteNumber(inline['durationHours']),
  };
}

/** Estimated engineering hours from a brief (deterministic, conservative). */
export function estimateHoursFromBrief(brief: string): number {
  const words = brief.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) {
    return 0;
  }
  if (words < 50) {
    return 4;
  }
  if (words < 200) {
    return 16;
  }
  if (words < 500) {
    return 40;
  }
  return 80;
}

/** AG-102 — Budget Estimator (F2). Deterministic, labelled, never a quote. */
export function estimateBudget(input: ClientStructuredInput) {
  const hours = input.durationHours ?? estimateHoursFromBrief(input.brief);
  const floor = CLIENT_FLOOR_HOURLY_RATE_USD;
  const calcMin = Math.max(CLIENT_MIN_BUDGET_USD, Math.round(hours * floor * 0.9));
  const calcMax = Math.max(calcMin, Math.round(hours * floor * 1.25));
  const userMin = input.budget?.min;
  const userMax = input.budget?.max;
  const min = finiteOr(userMin, calcMin);
  const max = finiteOr(userMax, calcMax);
  const source = userMin !== undefined || userMax !== undefined ? 'user' : 'calculated';
  return {
    range: {
      min: Math.max(CLIENT_MIN_BUDGET_USD, Math.min(min, max)),
      mid: Math.round(
        (Math.max(CLIENT_MIN_BUDGET_USD, Math.min(min, max)) +
          Math.max(CLIENT_MIN_BUDGET_USD, Math.max(min, max))) /
          2,
      ),
      max: Math.max(CLIENT_MIN_BUDGET_USD, Math.max(min, max)),
    },
    source,
    basis:
      source === 'user'
        ? 'client-provided budget range preserved, validated against the platform floor'
        : 'calculated from estimated hours and the conservative platform hourly floor',
    estimatedHours: hours,
    hourlyRateFloor: floor,
    assumptions: [
      'The hourly rate is a conservative platform floor, not a marketplace quote.',
      'Ranges outside a ±20% band of historical norms are flagged for review.',
    ],
    isEstimate: true,
    isQuote: false,
    currency: 'USD',
  };
}

/** AG-103 — Timeline Estimator (F3). Deterministic range, never a promise. */
export function estimateTimeline(
  input: ClientStructuredInput,
  budget?: Readonly<{ readonly range: { readonly mid: number } }>,
) {
  const budgetHours =
    budget !== undefined ? Math.round(budget.range.mid / CLIENT_FLOOR_HOURLY_RATE_USD) : 0;
  const hours =
    input.durationHours ?? (budgetHours > 0 ? budgetHours : estimateHoursFromBrief(input.brief));
  const weeksMin = Math.max(1, Math.ceil(hours / CLIENT_HOURS_PER_WEEK));
  const weeksMax = weeksMin + Math.max(1, Math.ceil(hours / (CLIENT_HOURS_PER_WEEK * 2)));
  const userMin = input.timeline?.weeksMin;
  const userMax = input.timeline?.weeksMax;
  return {
    range: {
      weeksMin: finiteOr(userMin, weeksMin),
      weeksMax: Math.max(finiteOr(userMin, weeksMin), finiteOr(userMax, weeksMax)),
    },
    source: userMin !== undefined || userMax !== undefined ? 'user' : 'calculated',
    estimatedHours: hours,
    assumptions: [
      'A single-team, one-track effort is assumed.',
      'This is an estimate, not a commitment; review against real milestones.',
    ],
    isEstimate: true,
    isQuote: false,
  };
}

/** AG-104 — Skills Recommendation (F4). Taxonomy only (catalog AC-06). */
export function recommendSkills(input: ClientStructuredInput) {
  const haystack =
    `${input.brief} ${(input.requirements ?? []).join(' ')} ${(input.skills ?? []).join(' ')}`.toLowerCase();
  const required: ClientSkill[] = [];
  const niceToHave: ClientSkill[] = [];
  for (const skill of CLIENT_SKILL_TAXONOMY) {
    const hits = skill.keywords.filter((keyword) =>
      haystack.includes(keyword.toLowerCase()),
    ).length;
    if (hits >= 2) {
      required.push(skill);
    } else if (hits === 1) {
      niceToHave.push(skill);
    }
  }
  return {
    required: required.map(({ id, label }) => ({ id, label })),
    niceToHave: niceToHave.map(({ id, label }) => ({ id, label })),
    taxonomyOnly: true,
    note: 'Only catalog taxonomy skills are returned (AC-06); no invented skill ids.',
  };
}

/** AG-105 — Project Success Score (F5). Advisory heuristic, never blocks. */
export function scoreProject(input: ClientStructuredInput) {
  let score = 0;
  const drivers: string[] = [];
  const isCompleteBrief =
    input.brief.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length >= 20;
  if (isCompleteBrief) {
    score += 25;
  } else {
    drivers.push('Write at least a short brief (20+ words) describing the project.');
  }
  if (input.headline !== undefined && input.headline.trim().length > 0) {
    score += 10;
  } else {
    drivers.push('Add a clear project headline.');
  }
  if (input.requirements.length > 0) {
    score += 20;
  } else {
    drivers.push('List concrete deliverables / acceptance criteria.');
  }
  if (input.budget?.min !== undefined || input.budget?.max !== undefined) {
    score += 15;
  } else {
    drivers.push('Provide an expected budget range.');
  }
  if (input.timeline?.weeksMin !== undefined || input.timeline?.weeksMax !== undefined) {
    score += 10;
  } else {
    drivers.push('Provide an expected timeline.');
  }
  const requiredSkills = recommendSkills(input).required.length;
  if (requiredSkills > 0) {
    score += 10;
  }
  const briefLength = input.brief.length;
  if (briefLength >= 50 && briefLength <= 800) {
    score += 10;
  } else if (briefLength > 0) {
    score += 5;
  }
  const clamped = Math.min(100, Math.max(0, score));
  const strength = clamped < 40 ? 'low' : clamped < 70 ? 'medium' : 'high';
  return {
    score: clamped,
    strength,
    drivers: drivers.slice(0, 3),
    advisoryOnly: true,
    confidence: clamped / 100,
    note: 'Advisory heuristic for brief completeness — never blocks publishing.',
  };
}

// ---------------------------------------------------------------------------
// Runtime agents
// ---------------------------------------------------------------------------

const DEP = (id: string) => ({ type: DependencyType.Agent, id, required: false });

function clientCapabilities(ids: readonly string[]): readonly AgentCapability[] {
  return Object.freeze(ids.map((id) => ({ id, name: id, enabled: true })));
}

/** AG-102 — Budget Estimator (deterministic; calculator allowlisted). */
export function createBudgetEstimatorAgent(): RuntimeAgent {
  const agentId = CLIENT_AGENT_IDS.budgetEstimator;
  return {
    configuration: {
      agentId,
      name: 'Budget Estimator',
      version: CLIENT_TEAM_VERSION,
      category: AgentCategory.Client,
      status: AgentStatus.InDevelopment,
      capabilities: clientCapabilities([CLIENT_CAPABILITY_IDS.budgetEstimate]),
      dependencies: Object.freeze([DEP(CLIENT_AGENT_IDS.projectDescription)]),
      limits: { maxTokens: 4000, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const delay = clampDelay(parseNumber(context.inputs['client.delayMs'], 0));
      if (delay > 0) {
        await wait(delay, context);
      }
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractStructuredInput(context.inputs);
      const estimate = estimateBudget(input);
      return {
        success: true,
        output: {
          budget: estimate,
          recommendations: [
            {
              agentId,
              capability: CLIENT_CAPABILITY_IDS.budgetEstimate,
              title: 'Budget range',
              recommendation: `Estimated budget: $${estimate.range.min}–$${estimate.range.max} USD (${estimate.source}).`,
              urgency: 'medium',
              confidence: estimate.range.mid > 0 ? 0.8 : 0.5,
            },
          ],
        },
        metadata: { provider: 'runtime', agentId, version: CLIENT_TEAM_VERSION },
      };
    },
  };
}

/** AG-103 — Timeline Estimator (deterministic). */
export function createTimelineEstimatorAgent(): RuntimeAgent {
  const agentId = CLIENT_AGENT_IDS.timelineEstimator;
  return {
    configuration: {
      agentId,
      name: 'Timeline Estimator',
      version: CLIENT_TEAM_VERSION,
      category: AgentCategory.Client,
      status: AgentStatus.InDevelopment,
      capabilities: clientCapabilities([CLIENT_CAPABILITY_IDS.timelineEstimate]),
      dependencies: Object.freeze([DEP(CLIENT_AGENT_IDS.projectDescription)]),
      limits: { maxTokens: 4000, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const delay = clampDelay(parseNumber(context.inputs['client.delayMs'], 0));
      if (delay > 0) {
        await wait(delay, context);
      }
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractStructuredInput(context.inputs);
      const budget = readOptionalBudget(context.inputs);
      const estimate = estimateTimeline(input, budget);
      return {
        success: true,
        output: {
          timeline: estimate,
          recommendations: [
            {
              agentId,
              capability: CLIENT_CAPABILITY_IDS.timelineEstimate,
              title: 'Timeline range',
              recommendation: `Estimated timeline: ${estimate.range.weeksMin}–${estimate.range.weeksMax} weeks (${estimate.source}).`,
              urgency: 'medium',
              confidence: 0.75,
            },
          ],
        },
        metadata: { provider: 'runtime', agentId, version: CLIENT_TEAM_VERSION },
      };
    },
  };
}

/** AG-104 — Skills Recommendation (deterministic taxonomy). */
export function createSkillsRecommendationAgent(): RuntimeAgent {
  const agentId = CLIENT_AGENT_IDS.skillsRecommendation;
  return {
    configuration: {
      agentId,
      name: 'Skills Recommendation Agent',
      version: CLIENT_TEAM_VERSION,
      category: AgentCategory.Client,
      status: AgentStatus.InDevelopment,
      capabilities: clientCapabilities([CLIENT_CAPABILITY_IDS.skillsRecommend]),
      dependencies: Object.freeze([DEP(CLIENT_AGENT_IDS.projectDescription)]),
      limits: { maxTokens: 4000, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractStructuredInput(context.inputs);
      const recommendation = recommendSkills(input);
      return {
        success: true,
        output: {
          skills: recommendation,
          recommendations: [
            {
              agentId,
              capability: CLIENT_CAPABILITY_IDS.skillsRecommend,
              title: 'Suggested skills',
              recommendation:
                recommendation.required.length > 0
                  ? `Recommended skill focus: ${recommendation.required.map((s) => s.label).join(', ')}.`
                  : 'No catalog skills matched the brief yet; enrich the description.',
              urgency: 'low',
              confidence: 0.7,
            },
          ],
        },
        metadata: { provider: 'runtime', agentId, version: CLIENT_TEAM_VERSION },
      };
    },
  };
}

/** AG-105 — Project Success Score (deterministic, advisory). */
export function createProjectSuccessScoreAgent(): RuntimeAgent {
  const agentId = CLIENT_AGENT_IDS.projectSuccessScore;
  return {
    configuration: {
      agentId,
      name: 'Project Success Score Agent',
      version: CLIENT_TEAM_VERSION,
      category: AgentCategory.Client,
      status: AgentStatus.InDevelopment,
      capabilities: clientCapabilities([CLIENT_CAPABILITY_IDS.projectScore]),
      dependencies: Object.freeze([
        DEP(CLIENT_AGENT_IDS.projectDescription),
        DEP(CLIENT_AGENT_IDS.budgetEstimator),
        DEP(CLIENT_AGENT_IDS.timelineEstimator),
        DEP(CLIENT_AGENT_IDS.skillsRecommendation),
      ]),
      limits: { maxTokens: 4000, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractStructuredInput(context.inputs);
      const scored = scoreProject(input);
      return {
        success: true,
        output: {
          score: scored,
          recommendations:
            scored.drivers.length > 0
              ? [
                  {
                    agentId,
                    capability: CLIENT_CAPABILITY_IDS.projectScore,
                    title: 'Improve brief completeness',
                    recommendation: scored.drivers[0]!,
                    urgency: scored.strength === 'low' ? 'high' : 'medium',
                    confidence: scored.confidence,
                  },
                ]
              : [],
        },
        metadata: { provider: 'runtime', agentId, version: CLIENT_TEAM_VERSION },
      };
    },
  };
}

/** All client-team runtime agents introduced by this module (AG-102..AG-105). */
export function createClientTeamAgents(): readonly RuntimeAgent[] {
  return [
    createBudgetEstimatorAgent(),
    createTimelineEstimatorAgent(),
    createSkillsRecommendationAgent(),
    createProjectSuccessScoreAgent(),
  ];
}

// ---------------------------------------------------------------------------
// Platform mirror definitions
// ---------------------------------------------------------------------------

/** Options for building client platform definitions. */
export interface ClientAgentDefinitionOptions {
  /** Tool allowlist (+ `calculator`) when AG-004 tools are enabled. */
  readonly toolsEnabled?: boolean;
}

/**
 * Platform mirror definitions for the client runtime agents (AG-102..AG-105).
 * Capabilities derive from the runtime agents; tool access is an explicit
 * policy layer on top (an empty allowlist is the fail-closed default).
 */
export function createClientTeamAgentDefinitions(
  options: ClientAgentDefinitionOptions = {},
): readonly AgentDefinition[] {
  const calculatorTool = options.toolsEnabled === true ? CLIENT_CALCULATOR_TOOL : undefined;
  return [
    {
      agentId: CLIENT_AGENT_IDS.budgetEstimator,
      name: 'Budget Estimator',
      version: CLIENT_TEAM_VERSION,
      description: 'Estimates project budgets from requirements and briefs (deterministic v1).',
      team: 'client',
      category: AgentCategory.Client,
      status: AgentStatus.Testing,
      capabilities: [capability(CLIENT_CAPABILITY_IDS.budgetEstimate)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: calculatorTool === undefined ? [] : [calculatorTool],
      permissions: ['knowledge.read', `${CLIENT_CAPABILITY_IDS.budgetEstimate}`],
      limits: {
        maxExecutionTimeMs: 60_000,
        maxReasoningTurns: 0,
        maxToolCalls: calculatorTool === undefined ? 0 : 1,
        maxContextBytes: 32_768,
        maxOutputBytes: 32_768,
        maxConcurrentExecutions: 2,
      },
      dependencies: [
        { type: DependencyType.Agent, id: CLIENT_AGENT_IDS.projectDescription, required: false },
      ],
      configuration: {},
    },
    {
      agentId: CLIENT_AGENT_IDS.timelineEstimator,
      name: 'Timeline Estimator',
      version: CLIENT_TEAM_VERSION,
      description: 'Estimates project timelines from requirements and briefs (deterministic v1).',
      team: 'client',
      category: AgentCategory.Client,
      status: AgentStatus.Testing,
      capabilities: [capability(CLIENT_CAPABILITY_IDS.timelineEstimate)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', CLIENT_CAPABILITY_IDS.timelineEstimate],
      limits: {
        maxExecutionTimeMs: 60_000,
        maxReasoningTurns: 0,
        maxToolCalls: 0,
        maxContextBytes: 32_768,
        maxOutputBytes: 32_768,
        maxConcurrentExecutions: 2,
      },
      dependencies: [
        { type: DependencyType.Agent, id: CLIENT_AGENT_IDS.projectDescription, required: false },
      ],
      configuration: {},
    },
    {
      agentId: CLIENT_AGENT_IDS.skillsRecommendation,
      name: 'Skills Recommendation Agent',
      version: CLIENT_TEAM_VERSION,
      description: 'Recommends catalog taxonomy skills from a project brief (deterministic v1).',
      team: 'client',
      category: AgentCategory.Client,
      status: AgentStatus.Testing,
      capabilities: [capability(CLIENT_CAPABILITY_IDS.skillsRecommend)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', CLIENT_CAPABILITY_IDS.skillsRecommend],
      limits: {
        maxExecutionTimeMs: 60_000,
        maxReasoningTurns: 0,
        maxToolCalls: 0,
        maxContextBytes: 32_768,
        maxOutputBytes: 32_768,
        maxConcurrentExecutions: 2,
      },
      dependencies: [
        { type: DependencyType.Agent, id: CLIENT_AGENT_IDS.projectDescription, required: false },
      ],
      configuration: {},
    },
    {
      agentId: CLIENT_AGENT_IDS.projectSuccessScore,
      name: 'Project Success Score Agent',
      version: CLIENT_TEAM_VERSION,
      description: 'Advisory completeness score for a project brief (deterministic v1).',
      team: 'client',
      category: AgentCategory.Client,
      status: AgentStatus.Testing,
      capabilities: [capability(CLIENT_CAPABILITY_IDS.projectScore)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', CLIENT_CAPABILITY_IDS.projectScore],
      limits: {
        maxExecutionTimeMs: 60_000,
        maxReasoningTurns: 0,
        maxToolCalls: 0,
        maxContextBytes: 32_768,
        maxOutputBytes: 32_768,
        maxConcurrentExecutions: 2,
      },
      dependencies: [
        { type: DependencyType.Agent, id: CLIENT_AGENT_IDS.projectDescription, required: false },
        { type: DependencyType.Agent, id: CLIENT_AGENT_IDS.budgetEstimator, required: false },
        { type: DependencyType.Agent, id: CLIENT_AGENT_IDS.timelineEstimator, required: false },
        { type: DependencyType.Agent, id: CLIENT_AGENT_IDS.skillsRecommendation, required: false },
      ],
      configuration: {},
    },
  ];
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function cancelled(agentId: string): RuntimeAgentExecutionResult {
  return {
    success: false,
    error: {
      code: 'EXECUTION_CANCELLED',
      message: `Agent ${agentId} stopped after cancellation`,
      retryable: false,
    },
  };
}

function wait(ms: number, context: RuntimeAgentExecutionContext): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void context.signal.waitForCancellation().then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function clampDelay(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), 5000);
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function readOptionalBudget(inputs: Readonly<Record<string, unknown>>) {
  const source = (inputs['input'] as Readonly<Record<string, unknown>> | undefined) ?? inputs;
  const budget = source['budget'] as { readonly range?: { readonly mid?: number } } | undefined;
  if (budget?.range?.mid !== undefined && typeof budget.range.mid === 'number') {
    return { range: { mid: budget.range.mid } };
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : undefined;
}

function asObject(value: unknown): { readonly [key: string]: unknown } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as { readonly [key: string]: unknown })
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
