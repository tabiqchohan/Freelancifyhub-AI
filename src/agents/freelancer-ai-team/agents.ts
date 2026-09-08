/**
 * Sprint 22 — Freelancer AI Team v1. Deterministic freelancer agents
 * (AG-201, AG-202, AG-206, AG-207 — catalog §11).
 *
 * Every freelancer agent is deterministic-first: it computes from its inputs
 * and the provided context and never requires an LLM. Nothing is fabricated:
 * generated content is limited to structured outlines/helpers, all numbers are
 * either observed or explicitly labelled estimates (BR-AI-5, catalog §11 and
 * the transparency rule). Tool results and memory/knowledge context are
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
import { CLIENT_SKILL_TAXONOMY } from '../client-ai-team/agents.js';
import {
  FREELANCER_AGENT_IDS,
  FREELANCER_CAPABILITY_IDS,
  FREELANCER_MAX_REQUIREMENTS,
  FREELANCER_MIN_SKILLS_FOR_COMPLETE,
  FREELANCER_TEAM_GROUP,
  FREELANCER_TEAM_VERSION,
} from './constants.js';
import { sanitizeFreelancerText } from './security.js';

/** A skill entry from the shared catalog taxonomy (AC-06 — taxonomy only). */
export interface FreelancerSkill {
  readonly id: string;
  readonly label: string;
  readonly keywords: readonly string[];
}

/** Re-uses the enforced catalog taxonomy; no second taxonomy is invented. */
export const FREELANCER_SKILL_TAXONOMY: readonly FreelancerSkill[] = CLIENT_SKILL_TAXONOMY;

/** Structured fields extracted from a freelancer task input (never invented). */
export interface FreelancerStructuredInput {
  readonly profile?: {
    readonly headline?: string;
    readonly bio?: string;
    readonly skills: readonly string[];
    readonly experience?: { readonly years?: number };
    readonly portfolioUrl?: string;
    readonly hourlyRate?: number;
    readonly availability?: string;
    readonly location?: string;
  };
  readonly project?: {
    readonly title?: string;
    readonly description?: string;
    readonly requirements: readonly string[];
    readonly requiredSkills: readonly string[];
    readonly category?: string;
  };
  readonly activity?: {
    readonly proposalsCount?: number;
    readonly projectsCompleted?: number;
    readonly ongoingProjects?: number;
    readonly totalEarnings?: number;
    readonly averageRating?: number;
    readonly reviewCount?: number;
    readonly onTimeDeliveryRate?: number;
  };
  readonly proposalDraft?: string;
}

/** Extracts structured freelancer input from arbitrary execution inputs. */
export function extractFreelancerInput(
  inputs: Readonly<Record<string, unknown>>,
): FreelancerStructuredInput {
  const inline = (inputs['input'] as Readonly<Record<string, unknown>> | undefined) ?? inputs;
  const profile = asObject(inputs['profile']) ?? asObject(inline['profile']);
  const project = asObject(inputs['project']) ?? asObject(inline['project']);
  const activity = asObject(inputs['activity']) ?? asObject(inline['activity']);
  return {
    profile:
      profile === undefined
        ? undefined
        : {
            headline: asString(profile['headline']),
            bio: sanitizeOptional(profile['bio']),
            skills: asStringArray(profile['skills']) ?? [],
            experience: asObject(profile['experience']) as { readonly years?: number } | undefined,
            portfolioUrl: asString(profile['portfolioUrl']),
            hourlyRate: asFiniteNumber(profile['hourlyRate']),
            availability: asString(profile['availability']),
            location: asString(profile['location']),
          },
    project:
      project === undefined
        ? undefined
        : {
            title: asString(project['title']),
            description: sanitizeOptional(project['description']),
            requirements: asStringArray(project['requirements']) ?? [],
            requiredSkills: asStringArray(project['requiredSkills']) ?? [],
            category: asString(project['category']),
          },
    activity:
      activity === undefined
        ? undefined
        : {
            proposalsCount: asFiniteNumber(activity['proposalsCount']),
            projectsCompleted: asFiniteNumber(activity['projectsCompleted']),
            ongoingProjects: asFiniteNumber(activity['ongoingProjects']),
            totalEarnings: asFiniteNumber(activity['totalEarnings']),
            averageRating: asFiniteNumber(activity['averageRating']),
            reviewCount: asFiniteNumber(activity['reviewCount']),
            onTimeDeliveryRate: asFiniteNumber(activity['onTimeDeliveryRate']),
          },
    proposalDraft:
      sanitizeOptional(inputs['proposalDraft']) ?? sanitizeOptional(inline['proposalDraft']),
  };
}

// ---------------------------------------------------------------------------
// Skill normalization (shared taxonomy)
// ---------------------------------------------------------------------------

/** A recognized skill mapping (raw declared phrase → catalog skill). */
export interface RecognizedSkill {
  readonly raw: string;
  readonly id: string;
  readonly label: string;
}

/** Result of normalizing free-form declared skills against the taxonomy. */
export interface SkillSummary {
  readonly recognized: readonly RecognizedSkill[];
  readonly duplicateIds: readonly string[];
  readonly unrecognized: readonly string[];
  readonly declaredCount: number;
}

/** Maps declared skill phrases to catalog skills; never invents ids. */
export function normalizeFreelancerSkills(rawSkills: readonly string[]): SkillSummary {
  const recognized: RecognizedSkill[] = [];
  const unrecognized: string[] = [];
  for (const raw of rawSkills.slice(0, 40)) {
    const phrase = sanitizeFreelancerText(raw, 128).toLowerCase();
    if (phrase.length === 0) {
      continue;
    }
    const match = findSkill(phrase);
    if (match !== undefined) {
      recognized.push({ raw: raw.trim(), id: match.id, label: match.label });
    } else {
      unrecognized.push(raw.trim());
    }
  }
  const counts = new Map<string, number>();
  for (const item of recognized) {
    counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  }
  const duplicateIds = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  return {
    recognized,
    duplicateIds,
    unrecognized: [...new Set(unrecognized)],
    declaredCount: rawSkills.length,
  };
}

function findSkill(phrase: string): { readonly id: string; readonly label: string } | undefined {
  for (const skill of FREELANCER_SKILL_TAXONOMY) {
    const keywordHit = skill.keywords.some((keyword) => {
      const term = keyword.toLowerCase().trim();
      return term.length >= 2 && (phrase.includes(term) || term.includes(phrase));
    });
    if (keywordHit) {
      return { id: skill.id, label: skill.label };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// AG-202 — Profile Optimizer (F7, catalog §11)
// ---------------------------------------------------------------------------

/** Empty profile default so deterministic analysis never touches undefined. */
const EMPTY_PROFILE: NonNullable<FreelancerStructuredInput['profile']> = Object.freeze({
  skills: [],
});

/** Deterministic profile-completeness assessment (advisory, not a score). */
export interface ProfileCompleteness {
  readonly score: number;
  readonly strength: 'low' | 'medium' | 'high';
  readonly present: readonly string[];
  readonly missing: readonly string[];
}

/** Deterministic profile analysis result. */
export interface ProfileAnalysis {
  readonly completeness: ProfileCompleteness;
  readonly skillSummary: SkillSummary;
  readonly suggestions: readonly string[];
}

/** AG-202 — analyze a freelancer profile (deterministic, no fabrication). */
export function analyzeProfile(input: FreelancerStructuredInput): ProfileAnalysis {
  const profile = input.profile ?? EMPTY_PROFILE;
  const skillSummary = normalizeFreelancerSkills(profile.skills);
  const completeness = assessProfileCompleteness(profile, skillSummary);
  const suggestions = profileSuggestions(completeness, skillSummary);
  return { completeness, skillSummary, suggestions };
}

function assessProfileCompleteness(
  profile: NonNullable<FreelancerStructuredInput['profile']>,
  skills: SkillSummary,
): ProfileCompleteness {
  const present: string[] = [];
  const missing: string[] = [];
  let score = 0;

  if (hasText(profile.headline)) {
    score += 15;
    present.push('headline');
  } else {
    missing.push('headline');
  }

  const bioWords = (profile.bio ?? '').split(/\s+/).filter(Boolean).length;
  if (bioWords >= 40) {
    score += 20;
    present.push('bio');
  } else if (bioWords >= 10) {
    score += 10;
    present.push('bio');
  } else if (bioWords > 0) {
    score += 6;
    present.push('bio');
  } else {
    missing.push('bio');
  }

  const unique = new Set(skills.recognized.map((item) => item.id)).size;
  if (unique >= FREELANCER_MIN_SKILLS_FOR_COMPLETE) {
    score += 25;
    present.push('skills');
  } else if (unique > 0) {
    score += 12;
    present.push('skills');
  } else {
    missing.push('skills');
  }

  if ((profile.experience?.years ?? 0) > 0) {
    score += 10;
    present.push('experience');
  } else {
    missing.push('experience');
  }

  if (hasText(profile.portfolioUrl)) {
    score += 10;
    present.push('portfolio');
  } else {
    missing.push('portfolio');
  }

  if ((profile.hourlyRate ?? 0) > 0) {
    score += 10;
    present.push('hourlyRate');
  } else {
    missing.push('hourlyRate');
  }

  if (hasText(profile.availability) || hasText(profile.location)) {
    score += 10;
    present.push('availability');
  } else {
    missing.push('availability');
  }

  const clamped = Math.min(100, Math.max(0, score));
  const strength = clamped < 40 ? 'low' : clamped < 70 ? 'medium' : 'high';
  return { score: clamped, strength, present, missing };
}

function profileSuggestions(
  completeness: ProfileCompleteness,
  skills: SkillSummary,
): readonly string[] {
  const suggestions: string[] = [];
  const byField: Readonly<Record<string, string>> = {
    headline: 'Add a clear headline that names your core service and target clients.',
    bio: 'Expand your bio to at least 40 words describing past outcomes.',
    skills: `Declare at least ${FREELANCER_MIN_SKILLS_FOR_COMPLETE} catalog skills so matching can work.`,
    experience: 'Quantify your experience (years) for credibility.',
    portfolio: 'Link a portfolio or past work so clients can verify quality.',
    hourlyRate: 'Set an hourly rate so budget-based matching can place you.',
    availability: 'Share your availability or location for scheduling.',
  };
  for (const field of completeness.missing) {
    const suggestion = byField[field];
    if (suggestion !== undefined) {
      suggestions.push(suggestion);
    }
  }
  if (skills.duplicateIds.length > 0) {
    suggestions.push(
      `Normalize overlapping skill declarations — ${skills.duplicateIds.join(', ')} appears more than once under different labels.`,
    );
  }
  if (skills.unrecognized.length > 0) {
    suggestions.push(
      `We could not map these declared skills to the catalog: ${skills.unrecognized.join(', ')}. Review and phrase them clearly.`,
    );
  }
  return suggestions.slice(0, 5);
}

// ---------------------------------------------------------------------------
// AG-206 — Project Recommendation (F11, catalog §11)
// ---------------------------------------------------------------------------

/** Deterministic project-match analysis result. */
export interface MatchAnalysis {
  readonly score: number;
  readonly strength: 'low' | 'medium' | 'high';
  readonly requiredSkillsAnalyzed: readonly string[];
  readonly matchedSkills: readonly string[];
  readonly missingSkills: readonly string[];
  readonly reasons: readonly string[];
  readonly confidence: number;
  readonly advisoryOnly: boolean;
  readonly note: string;
}

/** The required skill set a project implies (requiredSkills + brief hits). */
export function extractProjectRequiredSkills(
  project: NonNullable<FreelancerStructuredInput['project']>,
): readonly string[] {
  const fromList = project.requiredSkills.slice(0, 40).map((skill) => skill.trim());
  const haystack =
    `${project.title ?? ''} ${project.description ?? ''} ${project.requirements.join(' ')}`.toLowerCase();
  const fromBrief: string[] = [];
  for (const skill of FREELANCER_SKILL_TAXONOMY) {
    const hits = skill.keywords.filter((keyword) =>
      haystack.includes(keyword.toLowerCase()),
    ).length;
    if (hits >= 1) {
      fromBrief.push(skill.label);
    }
  }
  return dedupe([...fromList, ...fromBrief]).slice(0, 40);
}

/** AG-206 — deterministic, explainable fit score for a freelancer + project. */
export function matchProject(input: FreelancerStructuredInput): MatchAnalysis {
  const profile = input.profile ?? EMPTY_PROFILE;
  const project = input.project;
  if (project === undefined) {
    return {
      score: 0,
      strength: 'low',
      requiredSkillsAnalyzed: [],
      matchedSkills: [],
      missingSkills: [],
      reasons: ['No project was supplied to match against.'],
      confidence: 0.1,
      advisoryOnly: true,
      note: 'Deterministic heuristic — never a commitment to hire.',
    };
  }
  const freelancerSet = freelancerSkillSet(profile);
  const required = extractProjectRequiredSkills(project);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const skill of required) {
    if (matchesSkill(skill, freelancerSet)) {
      matched.push(skill);
    } else {
      missing.push(skill);
    }
  }
  const total = required.length;
  const ratio = total === 0 ? 0 : matched.length / total;
  const experienceFactor = Math.min(1, (profile.experience?.years ?? 0) / 10);
  const score =
    total === 0
      ? Math.round((freelancerSet.size > 0 ? 0.6 : 0.5) * 100)
      : Math.round(clamp01(0.9 * ratio + 0.1 * experienceFactor) * 100);
  const strength = score < 40 ? 'low' : score < 70 ? 'medium' : 'high';
  const reasons = buildMatchReasons(matched, missing, total, project, ratio);
  return {
    score,
    strength,
    requiredSkillsAnalyzed: required,
    matchedSkills: matched,
    missingSkills: missing,
    reasons,
    confidence: total === 0 ? 0.3 : Math.round(clamp01(0.5 + 0.4 * ratio) * 100) / 100,
    advisoryOnly: true,
    note: 'Deterministic heuristic — never a commitment to hire.',
  };
}

function buildMatchReasons(
  matched: readonly string[],
  missing: readonly string[],
  total: number,
  project: NonNullable<FreelancerStructuredInput['project']>,
  ratio: number,
): readonly string[] {
  const reasons: string[] = [];
  if (total > 0) {
    reasons.push(`${matched.length}/${total} required skills matched.`);
  }
  if (missing.length > 0) {
    reasons.push(`Missing skills: ${missing.join(', ')}.`);
  } else if (total > 0) {
    reasons.push("Strong overlap on the project's required skills.");
  }
  if (total === 0) {
    reasons.push('Add explicit requirements to the project for measurable matching.');
  }
  if (ratio >= 0.5) {
    reasons.push('Your profile overlaps more than half of the required skills.');
  }
  reasons.push(`Project category: ${project.category ?? 'not specified'}.`);
  return reasons.slice(0, 5);
}

function freelancerSkillSet(
  profile: NonNullable<FreelancerStructuredInput['profile']>,
): Set<string> {
  const set = new Set<string>();
  for (const raw of profile.skills) {
    const phrase = raw.trim().toLowerCase();
    if (phrase.length > 0) {
      set.add(phrase);
    }
  }
  const normalized = normalizeFreelancerSkills(profile.skills);
  for (const item of normalized.recognized) {
    set.add(item.id.toLowerCase());
    set.add(item.label.toLowerCase());
  }
  return set;
}

function matchesSkill(skill: string, set: ReadonlySet<string>): boolean {
  const phrase = skill.trim().toLowerCase();
  if (phrase.length === 0) {
    return false;
  }
  if (set.has(phrase)) {
    return true;
  }
  const taxonomy = FREELANCER_SKILL_TAXONOMY.find((entry) => entry.label.toLowerCase() === phrase);
  return taxonomy !== undefined && set.has(taxonomy.id);
}

// ---------------------------------------------------------------------------
// AG-201 — Proposal Writer (F6, catalog §11)
// ---------------------------------------------------------------------------

/** Deterministic proposal-analysis result. */
export interface ProposalAnalysis {
  /** Only ever a user-provided draft echoed back; never AI-fabricated. */
  readonly draft?: string;
  /** Structured outline automatically generated from the project brief. */
  readonly outline: readonly string[];
  readonly alignment: {
    readonly alignedRequirements: readonly string[];
    readonly missingThemes: readonly string[];
    readonly coverage: number;
    readonly total: number;
  };
  readonly suggestions: readonly string[];
  readonly warnings: readonly string[];
  readonly generated: { readonly outline: boolean; readonly draft: false };
  readonly distinction: {
    readonly providedFacts: {
      readonly hasDraft: boolean;
      readonly requirementsCount: number;
      readonly declaredSkillCount: number;
    };
    readonly analysis: { readonly isEstimate: true; readonly generatedText: 'outlineOnly' };
  };
}

/** AG-201 — analyse/draft a proposal (deterministic, never fabricates text). */
export function analyzeProposal(input: FreelancerStructuredInput): ProposalAnalysis {
  const profile = input.profile ?? EMPTY_PROFILE;
  const project = input.project;
  const draft = sanitizeOptional(input.proposalDraft);
  const requirements = (project?.requirements ?? []).slice(0, FREELANCER_MAX_REQUIREMENTS);
  const outline = buildProposalOutline(requirements);

  const alignedRequirements: string[] = [];
  const missingThemes: string[] = [];
  if (draft !== undefined) {
    const haystack = draft.toLowerCase();
    for (const requirement of requirements) {
      if (haystack.includes(probeFor(requirement))) {
        alignedRequirements.push(requirement);
      } else {
        missingThemes.push(requirement);
      }
    }
  } else if (requirements.length > 0) {
    missingThemes.push(...requirements);
  }
  const total = requirements.length;
  const coverage = total === 0 ? (draft !== undefined ? 1 : 0) : alignedRequirements.length / total;

  const suggestions: string[] = [];
  if (draft === undefined) {
    suggestions.push('Write an opening that shows you understand the brief.');
  }
  if (missingThemes.length > 0) {
    suggestions.push(
      `Cover these points in your draft: ${missingThemes.slice(0, 4).join(', ')}${missingThemes.length > 4 ? ', …' : ''}.`,
    );
  } else if (draft !== undefined && requirements.length > 0) {
    suggestions.push('Your draft already references every requested requirement.');
  }

  const warnings: string[] = [];
  if (draft === undefined) {
    warnings.push(
      'No draft provided — generated an outline only; proposal text is never fabricated.',
    );
  }
  if (profile.skills.length === 0) {
    warnings.push('Add skills to your profile so the proposal can reference verified strengths.');
  }

  return {
    draft,
    outline,
    alignment: { alignedRequirements, missingThemes, coverage, total },
    suggestions: suggestions.slice(0, 4),
    warnings: warnings.slice(0, 3),
    generated: { outline: true, draft: false },
    distinction: {
      providedFacts: {
        hasDraft: draft !== undefined,
        requirementsCount: total,
        declaredSkillCount: profile.skills.length,
      },
      analysis: { isEstimate: true, generatedText: 'outlineOnly' },
    },
  };
}

function buildProposalOutline(requirements: readonly string[]): readonly string[] {
  const outline = [
    'Summary of approach',
    'Relevant skills and experience',
    requirements.length > 0
      ? `Addressing the ${requirements.length} stated requirement${requirements.length === 1 ? '' : 's'}`
      : 'Understanding the brief',
    'Timeline and availability',
    'Deliverables and next steps',
  ];
  return outline;
}

function probeFor(requirement: string): string {
  const words = requirement
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 3);
  return words[0] ?? sanitizeFreelancerText(requirement, 128).toLowerCase();
}

// ---------------------------------------------------------------------------
// AG-207 — Career Advisor (F22, catalog §11)
// ---------------------------------------------------------------------------

/** Deterministic career-insight result. */
export interface InsightAnalysis {
  readonly dataSufficient: boolean;
  /** Only fields the request actually supplied — nothing is invented. */
  readonly signals: Readonly<Record<string, number>>;
  readonly derived: {
    readonly completionRate?: number;
    readonly earningsPerCompleted?: number;
  };
  readonly drivers: readonly string[];
  readonly summary: string;
}

/** AG-207 — deterministic, honest career guidance (no financial promises). */
export function analyzeInsights(input: FreelancerStructuredInput): InsightAnalysis {
  const activity = input.activity ?? {};
  const signals: Record<string, number> = {};
  const keys = [
    'proposalsCount',
    'projectsCompleted',
    'ongoingProjects',
    'totalEarnings',
    'averageRating',
    'reviewCount',
    'onTimeDeliveryRate',
  ] as const;
  for (const key of keys) {
    const value = activity[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      signals[key] = value;
    }
  }
  if (Object.keys(signals).length === 0) {
    return {
      dataSufficient: false,
      signals: {},
      derived: {},
      drivers: [],
      summary:
        'Not enough activity data to advise on — complete your profile and submit proposals so signals accumulate.',
    };
  }

  const derived: { completionRate?: number; earningsPerCompleted?: number } = {};
  const completed = signals['projectsCompleted'];
  const ongoing = signals['ongoingProjects'];
  const finished = (completed ?? 0) + (ongoing ?? 0);
  if (completed !== undefined && ongoing !== undefined && finished > 0) {
    derived.completionRate = Math.round((completed / finished) * 100);
  }
  if (typeof signals['totalEarnings'] === 'number' && finished > 0) {
    derived.earningsPerCompleted = Math.round(signals['totalEarnings']! / finished);
  }

  const drivers: string[] = [];
  const completenessScore = analyzeProfile(input).completeness.score;
  if (completenessScore < 70) {
    drivers.push(
      `Your profile completeness is ${completenessScore}/100 — improve it to raise discoverability.`,
    );
  }
  if (derived.completionRate !== undefined && derived.completionRate < 80) {
    drivers.push(`On-time completion is ${derived.completionRate}% — plan realistic milestones.`);
  }
  if (typeof signals['averageRating'] === 'number' && signals['averageRating']! < 4.5) {
    drivers.push(
      'Ratings below 4.5 reduce shortlist placement — invite feedback on completed projects.',
    );
  }
  if (typeof signals['proposalsCount'] === 'number' && signals['proposalsCount']! < 3) {
    drivers.push('Apply to more projects to raise your discovery between engagements.');
  }
  if (typeof signals['totalEarnings'] === 'number' && signals['totalEarnings'] === 0) {
    drivers.push(
      'No recorded earnings yet — completing your first project builds evaluation signals.',
    );
  }

  const summary = summarizeInsight(signals, derived, completed, finished);
  return {
    dataSufficient: true,
    signals,
    derived,
    drivers: drivers.slice(0, 3),
    summary,
  };
}

function summarizeInsight(
  signals: Readonly<Record<string, number>>,
  derived: InsightAnalysis['derived'],
  completed: number | undefined,
  finished: number,
): string {
  if (typeof signals['totalEarnings'] === 'number' && signals['totalEarnings']! > 0) {
    const per =
      derived.earningsPerCompleted !== undefined
        ? ` ($${derived.earningsPerCompleted}/finished project)`
        : '';
    return `You've earned $${signals['totalEarnings']}${per} across ${completed ?? finished} completed project${(completed ?? finished) === 1 ? '' : 's'}.`;
  }
  if (typeof signals['proposalsCount'] === 'number') {
    return `You've submitted ${signals['proposalsCount']} proposals on the platform.`;
  }
  if (typeof signals['averageRating'] === 'number') {
    return `Your average rating is ${signals['averageRating']} from ${signals['reviewCount'] ?? 0} reviews.`;
  }
  return 'Activity signals are available to guide your next career steps.';
}

// ---------------------------------------------------------------------------
// Runtime agents
// ---------------------------------------------------------------------------

const DEP = (id: string) => ({ type: DependencyType.Agent, id, required: false });

function freelancerCapabilities(ids: readonly string[]): readonly AgentCapability[] {
  return Object.freeze(ids.map((id) => ({ id, name: id, enabled: true })));
}

/** AG-202 — Profile Optimizer (deterministic profile analysis). */
export function createProfileOptimizerAgent(): RuntimeAgent {
  const agentId = FREELANCER_AGENT_IDS.profileOptimizer;
  return {
    configuration: {
      agentId,
      name: 'Profile Optimizer',
      version: FREELANCER_TEAM_VERSION,
      category: AgentCategory.Freelancer,
      status: AgentStatus.Draft,
      capabilities: freelancerCapabilities([FREELANCER_CAPABILITY_IDS.profileAnalyze]),
      dependencies: Object.freeze([]),
      limits: { maxTokens: 4000, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const delay = clampDelay(parseNumber(context.inputs['freelancer.delayMs'], 0));
      if (delay > 0) {
        await wait(delay, context);
      }
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractFreelancerInput(context.inputs);
      const profile = analyzeProfile(input);
      const recommendations = profileRecommendations(agentId, profile);
      return {
        success: true,
        output: {
          profile,
          recommendations,
        },
        metadata: { provider: 'runtime', agentId, version: FREELANCER_TEAM_VERSION },
      };
    },
  };
}

/** AG-201 — Proposal Writer (deterministic outline + alignment analysis). */
export function createProposalWriterAgent(): RuntimeAgent {
  const agentId = FREELANCER_AGENT_IDS.proposalWriter;
  return {
    configuration: {
      agentId,
      name: 'Proposal Writer',
      version: FREELANCER_TEAM_VERSION,
      category: AgentCategory.Freelancer,
      status: AgentStatus.InDevelopment,
      capabilities: freelancerCapabilities([FREELANCER_CAPABILITY_IDS.proposalDraft]),
      dependencies: Object.freeze([
        DEP(FREELANCER_AGENT_IDS.projectRecommendation),
        DEP(FREELANCER_AGENT_IDS.profileOptimizer),
      ]),
      limits: { maxTokens: 6000, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const delay = clampDelay(parseNumber(context.inputs['freelancer.delayMs'], 0));
      if (delay > 0) {
        await wait(delay, context);
      }
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractFreelancerInput(context.inputs);
      const proposal = analyzeProposal(input);
      const recommendations: {
        agentId: string;
        capability: string;
        title: string;
        recommendation: string;
        urgency: string;
        confidence: number;
      }[] = [];
      if (proposal.suggestions.length > 0) {
        recommendations.push({
          agentId,
          capability: FREELANCER_CAPABILITY_IDS.proposalDraft,
          title: 'Proposal improvement',
          recommendation: proposal.suggestions[0]!,
          urgency: 'medium',
          confidence: Math.round(proposal.alignment.coverage * 100) / 100,
        });
      }
      return {
        success: true,
        output: {
          proposal,
          recommendations,
        },
        metadata: { provider: 'runtime', agentId, version: FREELANCER_TEAM_VERSION },
      };
    },
  };
}

/** AG-206 — Project Recommendation (deterministic fit score). */
export function createProjectRecommendationAgent(): RuntimeAgent {
  const agentId = FREELANCER_AGENT_IDS.projectRecommendation;
  return {
    configuration: {
      agentId,
      name: 'Project Recommendation',
      version: FREELANCER_TEAM_VERSION,
      category: AgentCategory.Marketplace,
      status: AgentStatus.InDevelopment,
      capabilities: freelancerCapabilities([FREELANCER_CAPABILITY_IDS.projectMatch]),
      dependencies: Object.freeze([DEP(FREELANCER_AGENT_IDS.profileOptimizer)]),
      limits: { maxTokens: 4000, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const delay = clampDelay(parseNumber(context.inputs['freelancer.delayMs'], 0));
      if (delay > 0) {
        await wait(delay, context);
      }
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractFreelancerInput(context.inputs);
      const match = matchProject(input);
      const recommendations = [
        {
          agentId,
          capability: FREELANCER_CAPABILITY_IDS.projectMatch,
          title: 'Project fit',
          recommendation:
            match.requiredSkillsAnalyzed.length > 0
              ? `Fit score ${match.score}/100 — ${match.reasons[0] ?? 'review the project requirements.'}`
              : `Fit score ${match.score}/100 — no measurable requirements yet.`,
          urgency: match.strength === 'high' ? 'low' : 'medium',
          confidence: match.confidence,
        },
      ];
      return {
        success: true,
        output: {
          match,
          recommendations,
        },
        metadata: { provider: 'runtime', agentId, version: FREELANCER_TEAM_VERSION },
      };
    },
  };
}

/** AG-207 — Career Advisor (deterministic, honest guidance). */
export function createCareerAdvisorAgent(): RuntimeAgent {
  const agentId = FREELANCER_AGENT_IDS.careerAdvisor;
  return {
    configuration: {
      agentId,
      name: 'Career Advisor',
      version: FREELANCER_TEAM_VERSION,
      category: AgentCategory.Freelancer,
      status: AgentStatus.Draft,
      capabilities: freelancerCapabilities([FREELANCER_CAPABILITY_IDS.insightAnalyze]),
      dependencies: Object.freeze([DEP(FREELANCER_AGENT_IDS.profileOptimizer)]),
      limits: { maxTokens: 4000, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const delay = clampDelay(parseNumber(context.inputs['freelancer.delayMs'], 0));
      if (delay > 0) {
        await wait(delay, context);
      }
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractFreelancerInput(context.inputs);
      const insights = analyzeInsights(input);
      const recommendations = [
        {
          agentId,
          capability: FREELANCER_CAPABILITY_IDS.insightAnalyze,
          title: 'Career guidance',
          recommendation: insights.drivers[0] ?? insights.summary,
          urgency: insights.dataSufficient ? 'low' : 'medium',
          confidence: insights.dataSufficient ? 0.7 : 0.4,
        },
      ];
      return {
        success: true,
        output: {
          insights,
          recommendations,
        },
        metadata: { provider: 'runtime', agentId, version: FREELANCER_TEAM_VERSION },
      };
    },
  };
}

/** All freelancer-team runtime agents introduced by this module. */
export function createFreelancerTeamAgents(): readonly RuntimeAgent[] {
  return [
    createProfileOptimizerAgent(),
    createProposalWriterAgent(),
    createProjectRecommendationAgent(),
    createCareerAdvisorAgent(),
  ];
}

// ---------------------------------------------------------------------------
// Platform mirror definitions
// ---------------------------------------------------------------------------

/**
 * Platform mirror definitions for the freelancer runtime agents
 * (AG-201/AG-202/AG-206/AG-207). Tool access is an explicit policy layer on
 * top: every freelancer agent ships v1 with an empty allowlist (fail-closed),
 * so agentic tool calling is refused until a tool is explicitly enabled.
 */
export function createFreelancerTeamAgentDefinitions(): readonly AgentDefinition[] {
  return [
    {
      agentId: FREELANCER_AGENT_IDS.profileOptimizer,
      name: 'Profile Optimizer',
      version: FREELANCER_TEAM_VERSION,
      description:
        'Analyzes freelancer profile completeness and skill normalization (deterministic v1).',
      team: FREELANCER_TEAM_GROUP,
      category: AgentCategory.Freelancer,
      status: AgentStatus.Draft,
      capabilities: [capability(FREELANCER_CAPABILITY_IDS.profileAnalyze)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', FREELANCER_CAPABILITY_IDS.profileAnalyze],
      limits: {
        maxExecutionTimeMs: 60_000,
        maxReasoningTurns: 0,
        maxToolCalls: 0,
        maxContextBytes: 32_768,
        maxOutputBytes: 32_768,
        maxConcurrentExecutions: 2,
      },
      dependencies: [],
      configuration: {},
    },
    {
      agentId: FREELANCER_AGENT_IDS.proposalWriter,
      name: 'Proposal Writer',
      version: FREELANCER_TEAM_VERSION,
      description:
        'Aligns proposals with project requirements and outlines sections (deterministic v1).',
      team: FREELANCER_TEAM_GROUP,
      category: AgentCategory.Freelancer,
      status: AgentStatus.InDevelopment,
      capabilities: [capability(FREELANCER_CAPABILITY_IDS.proposalDraft)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', FREELANCER_CAPABILITY_IDS.proposalDraft],
      limits: {
        maxExecutionTimeMs: 60_000,
        maxReasoningTurns: 0,
        maxToolCalls: 0,
        maxContextBytes: 32_768,
        maxOutputBytes: 32_768,
        maxConcurrentExecutions: 2,
      },
      dependencies: [
        {
          type: DependencyType.Agent,
          id: FREELANCER_AGENT_IDS.projectRecommendation,
          required: false,
        },
        { type: DependencyType.Agent, id: FREELANCER_AGENT_IDS.profileOptimizer, required: false },
      ],
      configuration: {},
    },
    {
      agentId: FREELANCER_AGENT_IDS.projectRecommendation,
      name: 'Project Recommendation',
      version: FREELANCER_TEAM_VERSION,
      description:
        'Ranks a project vs a freelancer profile with an explainable fit score (deterministic v1).',
      team: FREELANCER_TEAM_GROUP,
      category: AgentCategory.Marketplace,
      status: AgentStatus.InDevelopment,
      capabilities: [capability(FREELANCER_CAPABILITY_IDS.projectMatch)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', FREELANCER_CAPABILITY_IDS.projectMatch],
      limits: {
        maxExecutionTimeMs: 60_000,
        maxReasoningTurns: 0,
        maxToolCalls: 0,
        maxContextBytes: 32_768,
        maxOutputBytes: 32_768,
        maxConcurrentExecutions: 2,
      },
      dependencies: [
        { type: DependencyType.Agent, id: FREELANCER_AGENT_IDS.profileOptimizer, required: false },
      ],
      configuration: {},
    },
    {
      agentId: FREELANCER_AGENT_IDS.careerAdvisor,
      name: 'Career Advisor',
      version: FREELANCER_TEAM_VERSION,
      description:
        'Recommends honest, signal-derived career actions for freelancers (deterministic v1).',
      team: FREELANCER_TEAM_GROUP,
      category: AgentCategory.Freelancer,
      status: AgentStatus.Draft,
      capabilities: [capability(FREELANCER_CAPABILITY_IDS.insightAnalyze)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', FREELANCER_CAPABILITY_IDS.insightAnalyze],
      limits: {
        maxExecutionTimeMs: 60_000,
        maxReasoningTurns: 0,
        maxToolCalls: 0,
        maxContextBytes: 32_768,
        maxOutputBytes: 32_768,
        maxConcurrentExecutions: 2,
      },
      dependencies: [
        { type: DependencyType.Agent, id: FREELANCER_AGENT_IDS.profileOptimizer, required: false },
      ],
      configuration: {},
    },
  ];
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function profileRecommendations(
  agentId: string,
  profile: ProfileAnalysis,
): readonly {
  readonly agentId: string;
  readonly capability: string;
  readonly title: string;
  readonly recommendation: string;
  readonly urgency: string;
  readonly confidence: number;
}[] {
  const recommendation = profile.suggestions[0];
  if (recommendation === undefined) {
    return [];
  }
  return [
    {
      agentId,
      capability: FREELANCER_CAPABILITY_IDS.profileAnalyze,
      title: 'Profile improvement',
      recommendation,
      urgency: profile.completeness.strength === 'low' ? 'high' : 'medium',
      confidence: profile.completeness.score / 100,
    },
  ];
}

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

function sanitizeOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const sanitized = sanitizeFreelancerText(value, 16_384);
  return sanitized.length === 0 ? undefined : sanitized;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
