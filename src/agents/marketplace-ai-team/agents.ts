/**
 * Sprint 23 — Marketplace AI Team v1. Deterministic marketplace agents
 * (AG-301..AG-306 — catalog §12) plus the marketplace intelligence layer.
 *
 * Every marketplace agent is deterministic-first: it computes from its inputs
 * and the provided context and never requires an LLM. Nothing is fabricated:
 * metrics come only from provided data; budget/opportunity signals are
 * observed, never invented; `isEstimate` labels and `insufficientData` states
 * follow the Sprint 21/22 estimate semantics and the data-honesty rule
 * (Sprint 23 §45). Tool results and memory/knowledge context are treated as
 * data. Cancellation is cooperative through the runtime signal.
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
  MARKETPLACE_AGENT_IDS,
  MARKETPLACE_CAPABILITY_IDS,
  MARKETPLACE_DEFAULT_LIMITS,
  MARKETPLACE_MAX_PROJECTS,
  MARKETPLACE_MIN_PROJECTS_FOR_METRICS,
  MARKETPLACE_TEAM_GROUP,
  MARKETPLACE_TEAM_VERSION,
} from './constants.js';
import { sanitizeMarketplaceText } from './security.js';

/** A skill entry from the shared catalog taxonomy (AC-06 — taxonomy only). */
export interface MarketplaceSkill {
  readonly id: string;
  readonly label: string;
  readonly keywords: readonly string[];
}

/** Re-uses the enforced catalog taxonomy; no second taxonomy is invented. */
export const MARKETPLACE_SKILL_TAXONOMY: readonly MarketplaceSkill[] = CLIENT_SKILL_TAXONOMY;

/** Structured fields extracted from a marketplace task input (never invented). */
export interface MarketplaceStructuredInput {
  readonly project?: {
    readonly title?: string;
    readonly description?: string;
    readonly requirements: readonly string[];
    readonly requiredSkills: readonly string[];
    readonly category?: string;
    readonly status?: string;
    readonly deliverables: readonly string[];
    readonly budget?: { readonly min?: number; readonly max?: number };
    readonly timeline?: { readonly weeksMin?: number; readonly weeksMax?: number };
  };
  readonly freelancer?: {
    readonly id?: string;
    readonly headline?: string;
    readonly bio?: string;
    readonly skills: readonly string[];
    readonly experience?: { readonly years?: number };
    readonly portfolioUrl?: string;
    readonly hourlyRate?: number;
    readonly category?: string;
    readonly availability?: string;
  };
  readonly agreement?: {
    readonly parties?: {
      readonly clientId?: string;
      readonly freelancerId?: string;
      readonly clientName?: string;
      readonly freelancerName?: string;
    };
    readonly budget?: { readonly min?: number; readonly max?: number };
    readonly fee?: number;
    readonly milestones: readonly {
      readonly title: string;
      readonly amount: number;
      readonly dueWeeks?: number;
      readonly deliverable?: string;
    }[];
    readonly terms: readonly string[];
    readonly jurisdiction?: string;
  };
  readonly message?: {
    readonly senderId?: string;
    readonly recipientId?: string;
    readonly body: string;
    readonly context?: string;
  };
  readonly signals?: {
    readonly newAccount?: boolean;
    readonly contactOffPlatform?: boolean;
    readonly paymentOutsidePlatform?: boolean;
    readonly urgencyPressure?: boolean;
    readonly suspiciousLink?: boolean;
    readonly messageCount?: number;
    readonly reportedBefore?: boolean;
  };
  readonly review?: {
    readonly engagementId?: string;
    readonly parties?: {
      readonly reviewerId?: string;
      readonly reviewedId?: string;
    };
    readonly outcomeAgreed?: boolean;
    readonly messages: readonly string[];
    readonly deliveredOnTime?: boolean;
    readonly qualityNotes?: string;
    readonly milestonesCount?: number;
  };
  readonly dispute?: {
    readonly disputeId?: string;
    readonly reason?: string;
    readonly openedAt?: string;
    readonly messages: readonly string[];
    readonly deliverables: readonly string[];
    readonly payments: readonly number[];
    readonly status?: string;
  };
  readonly marketplace?: {
    readonly projects: readonly NonNullable<MarketplaceStructuredInput['project']>[];
    readonly categories: readonly string[];
  };
}

/** Extracts structured marketplace input from arbitrary execution inputs. */
export function extractMarketplaceInput(
  inputs: Readonly<Record<string, unknown>>,
): MarketplaceStructuredInput {
  const inline = (inputs['input'] as Readonly<Record<string, unknown>> | undefined) ?? inputs;
  const project = asObject(inputs['project']) ?? asObject(inline['project']);
  const freelancer = asObject(inputs['freelancer']) ?? asObject(inline['freelancer']);
  const agreement = asObject(inputs['agreement']) ?? asObject(inline['agreement']);
  const message = asObject(inputs['message']) ?? asObject(inline['message']);
  const signals = asObject(inputs['signals']) ?? asObject(inline['signals']);
  const review = asObject(inputs['review']) ?? asObject(inline['review']);
  const dispute = asObject(inputs['dispute']) ?? asObject(inline['dispute']);
  const marketplace = asObject(inputs['marketplace']) ?? asObject(inline['marketplace']);
  return {
    project:
      project === undefined
        ? undefined
        : {
            title: asString(project['title']),
            description: sanitizeOptional(project['description']),
            requirements: asStringArray(project['requirements']) ?? [],
            requiredSkills: asStringArray(project['requiredSkills']) ?? [],
            category: asString(project['category']),
            status: asString(project['status']),
            deliverables: asStringArray(project['deliverables']) ?? [],
            budget: asBudget(project['budget']),
            timeline: asTimeline(project['timeline']),
          },
    freelancer:
      freelancer === undefined
        ? undefined
        : {
            id: asString(freelancer['id']),
            headline: asString(freelancer['headline']),
            bio: sanitizeOptional(freelancer['bio']),
            skills: asStringArray(freelancer['skills']) ?? [],
            experience: asObject(freelancer['experience']) as
              { readonly years?: number } | undefined,
            portfolioUrl: asString(freelancer['portfolioUrl']),
            hourlyRate: asFiniteNumber(freelancer['hourlyRate']),
            category: asString(freelancer['category']),
            availability: asString(freelancer['availability']),
          },
    agreement:
      agreement === undefined
        ? undefined
        : {
            parties: asObject(agreement['parties']) as
              | {
                  readonly clientId?: string;
                  readonly freelancerId?: string;
                  readonly clientName?: string;
                  readonly freelancerName?: string;
                }
              | undefined,
            budget: asBudget(agreement['budget']),
            fee: asFiniteNumber(agreement['fee']),
            milestones:
              asMilestoneArray(agreement['milestones']) ??
              (Array.isArray(agreement['milestones']) ? [] : []),
            terms: asStringArray(agreement['terms']) ?? [],
            jurisdiction: asString(agreement['jurisdiction']),
          },
    message:
      message === undefined
        ? undefined
        : {
            senderId: asString(message['senderId']),
            recipientId: asString(message['recipientId']),
            body: asString(message['body']) ?? '',
            context: asString(message['context']),
          },
    signals:
      signals === undefined
        ? undefined
        : {
            newAccount: asBoolean(signals['newAccount']),
            contactOffPlatform: asBoolean(signals['contactOffPlatform']),
            paymentOutsidePlatform: asBoolean(signals['paymentOutsidePlatform']),
            urgencyPressure: asBoolean(signals['urgencyPressure']),
            suspiciousLink: asBoolean(signals['suspiciousLink']),
            messageCount: asFiniteNumber(signals['messageCount']),
            reportedBefore: asBoolean(signals['reportedBefore']),
          },
    review:
      review === undefined
        ? undefined
        : {
            engagementId: asString(review['engagementId']),
            parties: asObject(review['parties']) as
              { readonly reviewerId?: string; readonly reviewedId?: string } | undefined,
            outcomeAgreed: asBoolean(review['outcomeAgreed']),
            messages: asStringArray(review['messages']) ?? [],
            deliveredOnTime: asBoolean(review['deliveredOnTime']),
            qualityNotes: asString(review['qualityNotes']),
            milestonesCount: asFiniteNumber(review['milestonesCount']),
          },
    dispute:
      dispute === undefined
        ? undefined
        : {
            disputeId: asString(dispute['disputeId']),
            reason: asString(dispute['reason']),
            openedAt: asString(dispute['openedAt']),
            messages: asStringArray(dispute['messages']) ?? [],
            deliverables: asStringArray(dispute['deliverables']) ?? [],
            payments: asNumberArray(dispute['payments']) ?? [],
            status: asString(dispute['status']),
          },
    marketplace:
      marketplace === undefined
        ? undefined
        : {
            projects: asProjectArray(marketplace['projects']) ?? [],
            categories: asStringArray(marketplace['categories']) ?? [],
          },
  };
}

function asProjectArray(
  value: unknown,
): readonly NonNullable<MarketplaceStructuredInput['project']>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .map(asObject)
    .filter((entry): entry is { readonly [key: string]: unknown } => entry !== undefined)
    .map((entry) => ({
      title: asString(entry['title']),
      description: sanitizeOptional(entry['description']),
      requirements: asStringArray(entry['requirements']) ?? [],
      requiredSkills: asStringArray(entry['requiredSkills']) ?? [],
      category: asString(entry['category']),
      status: asString(entry['status']),
      deliverables: asStringArray(entry['deliverables']) ?? [],
      budget: asBudget(entry['budget']),
      timeline: asTimeline(entry['timeline']),
    }))
    .slice(0, MARKETPLACE_MAX_PROJECTS);
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
export function normalizeMarketplaceSkills(rawSkills: readonly string[]): SkillSummary {
  const recognized: RecognizedSkill[] = [];
  const unrecognized: string[] = [];
  for (const raw of rawSkills.slice(0, 40)) {
    const phrase = sanitizeMarketplaceText(raw, 128).toLowerCase();
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
  for (const skill of MARKETPLACE_SKILL_TAXONOMY) {
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
// Marketplace matching (§9 — reusable, deterministic, testable)
// ---------------------------------------------------------------------------

/** A matched/missing requirement pair for a freelancer-vs-project fit. */
export interface MarketplaceMatch {
  readonly score: number;
  readonly strength: 'low' | 'medium' | 'high';
  readonly matchedSkills: readonly string[];
  readonly missingSkills: readonly string[];
  readonly requirementCoverage: number;
  readonly requiredSkillsAnalyzed: readonly string[];
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  /** Documented heuristic — never a hire promise and not a market claim. */
  readonly methodology: string;
  readonly advisoryOnly: boolean;
  readonly confidence: number;
  readonly note: string;
}

/** The required skill set a project implies (requiredSkills + brief hits). */
export function extractMarketplaceRequiredSkills(
  project: NonNullable<MarketplaceStructuredInput['project']>,
): readonly string[] {
  const fromList = project.requiredSkills.slice(0, 40).map((skill) => skill.trim());
  const haystack =
    `${project.title ?? ''} ${project.description ?? ''} ${project.requirements.join(' ')}`.toLowerCase();
  const fromBrief: string[] = [];
  for (const skill of MARKETPLACE_SKILL_TAXONOMY) {
    const hits = skill.keywords.filter((keyword) =>
      haystack.includes(keyword.toLowerCase()),
    ).length;
    if (hits >= 1) {
      fromBrief.push(skill.label);
    }
  }
  return dedupe([...fromList, ...fromBrief]).slice(0, 40);
}

/**
 * Marketplace matching heuristic. Score = weighted skill overlap +
 * experience factor; never statistically authoritative. Documented in
 * docs/sprint23-marketplace-ai-team-v1.md §7.
 */
export function analyzeMarketplaceMatch(input: MarketplaceStructuredInput): MarketplaceMatch {
  const freelancer = input.freelancer;
  const project = input.project;
  if (freelancer === undefined || project === undefined) {
    return {
      score: 0,
      strength: 'low',
      matchedSkills: [],
      missingSkills: [],
      requirementCoverage: 0,
      requiredSkillsAnalyzed: [],
      reasons: ['A freelancer and a project are both required for matching.'],
      warnings: ['Matching is limited to the project actually provided to the agent.'],
      methodology: MARKETPLACE_MATCH_METHODOLOGY,
      advisoryOnly: true,
      confidence: 0.1,
      note: 'Deterministic heuristic — never a commitment to hire.',
    };
  }
  const freelancerSet = freelancerSkillSet(freelancer);
  const required = extractMarketplaceRequiredSkills(project);
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
  const coverage = total === 0 ? 1 : matched.length / total;
  const experienceFactor = Math.min(1, (freelancer.experience?.years ?? 0) / 10);
  const score =
    total === 0
      ? Math.round((freelancerSet.size > 0 ? 0.6 : 0.5) * 100)
      : Math.round(clamp01(0.9 * coverage + 0.1 * experienceFactor) * 100);
  const strength = score < 40 ? 'low' : score < 70 ? 'medium' : 'high';
  return {
    score,
    strength,
    matchedSkills: matched,
    missingSkills: missing,
    requirementCoverage: Math.round(coverage * 100) / 100,
    requiredSkillsAnalyzed: required,
    reasons: buildMatchReasons(matched, missing, total, project, coverage),
    warnings: ['Matching is limited to the project actually provided to the agent.'],
    methodology: MARKETPLACE_MATCH_METHODOLOGY,
    advisoryOnly: true,
    confidence: total === 0 ? 0.3 : Math.round(clamp01(0.5 + 0.4 * coverage) * 100) / 100,
    note: 'Deterministic heuristic — never a commitment to hire.',
  };
}

const MARKETPLACE_MATCH_METHODOLOGY =
  'Deterministic skill-overlap heuristic: score = 90% matched-requirement coverage + 10% capped experience, over the project required skills and the shared catalog taxonomy. Not a statistical or ML model; advisory only.';

function buildMatchReasons(
  matched: readonly string[],
  missing: readonly string[],
  total: number,
  project: NonNullable<MarketplaceStructuredInput['project']>,
  coverage: number,
): readonly string[] {
  const reasons: string[] = [];
  if (total > 0) {
    reasons.push(`${matched.length}/${total} required skills matched.`);
  }
  if (missing.length > 0) {
    reasons.push(
      `Missing skills: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}.`,
    );
  } else if (total > 0) {
    reasons.push("Strong overlap on the project's required skills.");
  }
  if (total === 0) {
    reasons.push('Add explicit requirements to the project for measurable matching.');
  }
  if (coverage >= 0.5) {
    reasons.push('The profile overlaps more than half of the required skills.');
  }
  reasons.push(`Project category: ${project.category ?? 'not specified'}.`);
  return reasons.slice(0, 5);
}

function freelancerSkillSet(
  freelancer: NonNullable<MarketplaceStructuredInput['freelancer']>,
): Set<string> {
  const set = new Set<string>();
  for (const raw of freelancer.skills) {
    const phrase = raw.trim().toLowerCase();
    if (phrase.length > 0) {
      set.add(phrase);
    }
  }
  const normalized = normalizeMarketplaceSkills(freelancer.skills);
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
  const taxonomy = MARKETPLACE_SKILL_TAXONOMY.find((entry) => entry.label.toLowerCase() === phrase);
  return taxonomy !== undefined && set.has(taxonomy.id);
}

// ---------------------------------------------------------------------------
// Project discovery (§8 — deterministic ranking of PROVIDED projects)
// ---------------------------------------------------------------------------

/** A ranked project candidate discovered from the provided dataset. */
export interface DiscoveredProject {
  readonly title?: string;
  readonly category?: string;
  readonly fitScore: number;
  readonly matchedSkills: readonly string[];
  readonly missingSkills: readonly string[];
  readonly reasons: readonly string[];
}

/** Result of deterministic discovery over the projects actually provided. */
export interface MarketplaceDiscovery {
  readonly dataSufficient: boolean;
  readonly discovered: readonly DiscoveredProject[];
  readonly projectCountProvided: number;
  readonly warnings: readonly string[];
  readonly note: string;
}

/** AG-206-style deterministic discovery/rank over the provided inventory. */
export function discoverMarketplaceProjects(
  input: MarketplaceStructuredInput,
): MarketplaceDiscovery {
  const freelancer = input.freelancer;
  const projects = input.marketplace?.projects ?? [];
  if (projects.length === 0) {
    return {
      dataSufficient: false,
      discovered: [],
      projectCountProvided: 0,
      warnings: ['No project inventory was provided — discovery is limited to supplied data.'],
      note: 'There is no marketplace project index in the repository; nothing is fabricated.',
    };
  }
  if (freelancer === undefined) {
    return {
      dataSufficient: false,
      discovered: [],
      projectCountProvided: projects.length,
      warnings: ['A freelancer profile is required to rank projects.'],
      note: 'Discovery ranks only the projects actually provided.',
    };
  }
  const ranked = projects
    .map((project) => {
      const candidate: MarketplaceStructuredInput = {
        freelancer,
        project,
      };
      const match = analyzeMarketplaceMatch(candidate);
      return {
        title: project.title,
        category: project.category,
        fitScore: match.score,
        matchedSkills: match.matchedSkills.slice(0, 5),
        missingSkills: match.missingSkills.slice(0, 5),
        reasons: match.reasons.slice(0, 3),
      };
    })
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, 10);
  return {
    dataSufficient: true,
    discovered: ranked,
    projectCountProvided: projects.length,
    warnings: ['Discovery ranks only the projects actually provided to the agent.'],
    note: 'Ranking is a deterministic skill-overlap heuristic; never a guarantee of award.',
  };
}

// ---------------------------------------------------------------------------
// Project quality analysis (§10 — neutral classifications, evidence-based)
// ---------------------------------------------------------------------------

/** A single deterministic quality finding. */
export interface QualityFinding {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
}

/** Neutral project-quality result (§10 — no objective "bad" judgment). */
export interface ProjectQualityResult {
  readonly status:
    'complete' | 'incomplete' | 'ambiguous' | 'needs clarification' | 'insufficient data';
  readonly findings: readonly QualityFinding[];
  readonly missingInformation: readonly string[];
  readonly recommendations: readonly string[];
  readonly aiGeneratedSuggestions: readonly string[];
  readonly evidence: { readonly projectProvided: boolean };
}

/** AG-301 / marketplace intelligence — deterministic project-quality checks. */
export function analyzeProjectQuality(input: MarketplaceStructuredInput): ProjectQualityResult {
  const project = input.project;
  if (project === undefined) {
    return {
      status: 'insufficient data',
      findings: [{ code: 'no_project', severity: 'error', message: 'No project was provided.' }],
      missingInformation: ['project'],
      recommendations: ['Provide the project so deterministic quality checks can run.'],
      aiGeneratedSuggestions: [],
      evidence: { projectProvided: false },
    };
  }
  const findings: QualityFinding[] = [];
  const missing: string[] = [];
  const recommendations: string[] = [];

  if (!hasText(project.title)) {
    findings.push({
      code: 'missing_title',
      severity: 'warning',
      message: 'Project title is missing.',
    });
    missing.push('title');
  }
  const descriptionWords = (project.description ?? '').split(/\s+/).filter(Boolean).length;
  if (descriptionWords === 0) {
    findings.push({
      code: 'missing_description',
      severity: 'warning',
      message: 'Project description is missing.',
    });
    missing.push('description');
  } else if (descriptionWords < 40) {
    findings.push({
      code: 'short_description',
      severity: 'warning',
      message: 'Project description is very short (fewer than 40 words).',
    });
  }
  const hasSkills =
    project.requiredSkills.length > 0 || extractMarketplaceRequiredSkills(project).length > 0;
  if (!hasSkills) {
    findings.push({
      code: 'missing_skills',
      severity: 'warning',
      message: 'No required skills found.',
    });
    missing.push('skills');
  }
  const hasScope = project.requirements.length > 0 || project.deliverables.length > 0;
  if (!hasScope) {
    findings.push({
      code: 'unclear_deliverables',
      severity: 'warning',
      message: 'No requirements or deliverables are listed.',
    });
    missing.push('deliverables');
  } else if (project.description !== undefined && project.requirements.length === 0) {
    findings.push({
      code: 'ambiguous_scope',
      severity: 'warning',
      message: 'A description exists but no explicit requirements — scope needs clarification.',
    });
  }
  if (
    project.timeline === undefined ||
    (project.timeline.weeksMin === undefined && project.timeline.weeksMax === undefined)
  ) {
    findings.push({
      code: 'missing_timeline',
      severity: 'warning',
      message: 'No timeline was provided.',
    });
    missing.push('timeline');
  }
  const budgetAmbiguous = project.budget === undefined;
  if (budgetAmbiguous) {
    findings.push({
      code: 'unclear_budget',
      severity: 'warning',
      message: 'No budget range was provided.',
    });
    missing.push('budget');
  }
  const contradictory: string[] = [];
  if (project.budget !== undefined) {
    const { min, max } = project.budget;
    if (min !== undefined && max !== undefined && min > max) {
      contradictory.push('budget.min exceeds budget.max');
    }
  }
  if (project.timeline !== undefined) {
    const { weeksMin, weeksMax } = project.timeline;
    if (weeksMin !== undefined && weeksMax !== undefined && weeksMin > weeksMax) {
      contradictory.push('timeline.weeksMin exceeds timeline.weeksMax');
    }
  }
  for (const contradiction of contradictory) {
    findings.push({
      code: 'contradictory_requirements',
      severity: 'error',
      message: contradiction,
    });
  }
  const broad = (project.requirements ?? []).filter(
    (requirement) => requirement.length > 200,
  ).length;
  if (broad > 0) {
    findings.push({
      code: 'overly_broad_requirements',
      severity: 'info',
      message: `${broad} requirement${broad === 1 ? '' : 's'} exceed${broad === 1 ? 's' : ''} 200 characters and may be overly broad.`,
    });
  }

  for (const finding of findings) {
    if (finding.severity === 'warning' && finding.code !== 'unclear_budget') {
      recommendations.push(finding.message.replace(/\.$/, '') + '.');
    }
  }
  if (
    project.requirements.length === 0 &&
    project.deliverables.length === 0 &&
    project.description !== undefined
  ) {
    recommendations.push('Split the description into explicit, checkable requirements.');
  }
  if (project.budget !== undefined && !hasScope) {
    recommendations.push(
      'Attach a scope before trusting the budget — budget without deliverables is ambiguous.',
    );
  }

  const status: ProjectQualityResult['status'] =
    contradictory.length > 0
      ? 'ambiguous'
      : missing.length === 0
        ? 'complete'
        : budgetAmbiguous && missing.length === 1
          ? 'needs clarification'
          : descriptionWords === 0 && missing.length > 1
            ? 'incomplete'
            : project.requirements.length === 0
              ? 'needs clarification'
              : 'incomplete';

  return {
    status,
    findings: findings.slice(0, 12),
    missingInformation: dedupe(missing).slice(0, 8),
    recommendations: recommendations.slice(0, 6),
    aiGeneratedSuggestions: [],
    evidence: { projectProvided: true },
  };
}

// ---------------------------------------------------------------------------
// Budget intelligence (§11 — observed structure; never market rates)
// ---------------------------------------------------------------------------

/** Bounded pricing/budget analysis result (§11 + Sprint 21/22 semantics). */
export interface BudgetAnalysis {
  readonly budgetProvided: boolean;
  readonly resolvedTotal?: number;
  readonly structureValid: boolean;
  readonly findings: readonly QualityFinding[];
  readonly concerns: readonly string[];
  readonly isEstimate: boolean;
  readonly estimate?: undefined;
  readonly marketRate: 'unavailable';
  readonly evidence: readonly string[];
  readonly nonBindingGuidance: string;
}

/** AG-302 — deterministic budget-structure validation (no fabricated prices). */
export function analyzeBudget(input: MarketplaceStructuredInput): BudgetAnalysis {
  const budget = input.agreement?.budget ?? input.project?.budget;
  const findings: QualityFinding[] = [];
  const concerns: string[] = [];
  const evidence: string[] = [];

  if (budget === undefined || (budget.min === undefined && budget.max === undefined)) {
    return {
      budgetProvided: false,
      structureValid: false,
      findings: [
        { code: 'missing_budget', severity: 'warning', message: 'No budget range was provided.' },
      ],
      concerns: ['Budget is missing — cannot validate structure or escrow split.'],
      isEstimate: false,
      estimate: undefined,
      marketRate: 'unavailable',
      evidence: [],
      nonBindingGuidance:
        'Provide a budget range so deterministic budget analysis can run. No market rate is claimed.',
    };
  }
  const { min, max } = budget;
  if (min !== undefined && max !== undefined && min > max) {
    findings.push({
      code: 'reversed_range',
      severity: 'error',
      message: 'Budget min exceeds max — the range is contradictory.',
    });
  }
  evidence.push(`budget.min: ${min ?? 'not provided'}`);
  evidence.push(`budget.max: ${max ?? 'not provided'}`);
  const resolvedTotal = max ?? min;
  const scope =
    (input.project?.requirements.length ?? 0) +
    (input.project?.deliverables.length ?? 0) +
    (input.agreement?.milestones.length ?? 0);
  if (scope === 0) {
    findings.push({
      code: 'budget_without_scope',
      severity: 'warning',
      message: 'A budget exists but no scope, deliverables or milestones are defined.',
    });
    concerns.push('Budget without a defined scope is ambiguous.');
  }

  return {
    budgetProvided: true,
    resolvedTotal,
    structureValid: findings.every((finding) => finding.severity !== 'error'),
    findings: findings.slice(0, 8),
    concerns: concerns.slice(0, 4),
    isEstimate: false,
    estimate: undefined,
    marketRate: 'unavailable',
    evidence: evidence.slice(0, 6),
    nonBindingGuidance:
      'Budget analysis is structural and non-binding. No market-rate claim is made without an actual historical pricing dataset.',
  };
}

// ---------------------------------------------------------------------------
// Marketplace insights (§12 — observed metrics only)
// ---------------------------------------------------------------------------

/** An observed skill-demand tally across the provided project dataset. */
export interface SkillDemandEntry {
  readonly skill: string;
  readonly count: number;
}

/** Marketplace insights result — metrics computed only from provided data. */
export interface MarketplaceInsights {
  readonly insufficientData: boolean;
  readonly availableSignals: {
    readonly projectCount: number;
    readonly categoryCounts: readonly { readonly category: string; readonly count: number }[];
    readonly statusDistribution: readonly { readonly status: string; readonly count: number }[];
    readonly skillDemand: readonly SkillDemandEntry[];
    readonly budgetDistribution: readonly { readonly label: string; readonly count: number }[];
  };
  readonly observedMetrics: readonly string[];
  readonly insights: readonly string[];
  readonly recommendations: readonly string[];
  readonly fabricated: false;
  readonly note: string;
}

/** AG-304 — deterministic marketplace insights from the provided dataset. */
export function computeMarketplaceInsights(input: MarketplaceStructuredInput): MarketplaceInsights {
  const projects = input.marketplace?.projects ?? [];

  const categoryCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const skillDemand = new Map<string, number>();
  const budgets: Array<number | undefined> = [];
  for (const project of projects) {
    const category = project.category ?? 'unspecified';
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    const status = project.status ?? 'unspecified';
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    const required = extractMarketplaceRequiredSkills(project);
    for (const skill of required) {
      skillDemand.set(skill, (skillDemand.get(skill) ?? 0) + 1);
    }
    budgets.push(project.budget?.max !== undefined ? project.budget.max : project.budget?.min);
  }

  const budgetLabels = ['under 1k', '1k to 5k', '5k to 20k', 'over 20k'];
  const budgetCounts = new Map<string, number>(budgetLabels.map((label) => [label, 0]));
  for (const value of budgets) {
    if (value === undefined) {
      continue;
    }
    const label =
      value < 1000
        ? 'under 1k'
        : value < 5000
          ? '1k to 5k'
          : value < 20000
            ? '5k to 20k'
            : 'over 20k';
    budgetCounts.set(label, (budgetCounts.get(label) ?? 0) + 1);
  }

  const categoryCountsList = [...categoryCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
  const statusDistribution = [...statusCounts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);
  const skillDemandList = [...skillDemand.entries()]
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const budgetDistribution =
    budgetCounts.size > 0
      ? budgetLabels
          .filter((label) => (budgetCounts.get(label) ?? 0) > 0)
          .map((label) => ({ label, count: budgetCounts.get(label) ?? 0 }))
      : [];

  const insufficient = projects.length < MARKETPLACE_MIN_PROJECTS_FOR_METRICS;
  const safe = (text: string): string => text;
  const observedMetrics = insufficient
    ? []
    : [
        `${projects.length} projects observed`,
        ...(categoryCountsList.length > 0
          ? [`top category: ${categoryCountsList[0]!.category} (${categoryCountsList[0]!.count})`]
          : []),
        ...(skillDemandList.length > 0
          ? [`top skill demand: ${skillDemandList[0]!.skill} (${skillDemandList[0]!.count})`]
          : []),
      ];
  const insights = insufficient
    ? []
    : [
        categoryCountsList.length > 0
          ? `${categoryCountsList[0]!.category} is the most represented category in the provided dataset.`
          : 'No category signal is available in the provided dataset.',
        skillDemandList.length > 0
          ? `${skillDemandList[0]!.skill} appears most often among the provided projects.`
          : 'No skill-demand signal is available in the provided dataset.',
      ];
  const recommendations = !insufficient
    ? [
        'Re-run insights as more projects are provided for observation.',
        'Use the observed category/skill signals for marketplace guidance only.',
      ]
    : [
        safe(
          `Insufficient data (${projects.length} project${projects.length === 1 ? '' : 's'} provided); observations are not reported.`,
        ),
        safe('Provide a larger project dataset for deterministic marketplace insights.'),
      ];

  return {
    insufficientData: insufficient,
    availableSignals: {
      projectCount: projects.length,
      categoryCounts: categoryCountsList.slice(0, 8),
      statusDistribution: statusDistribution.slice(0, 8),
      skillDemand: skillDemandList,
      budgetDistribution: budgetDistribution.slice(0, 8),
    },
    observedMetrics: observedMetrics.slice(0, 10),
    insights: insights.slice(0, 4),
    recommendations: recommendations.slice(0, 4),
    fabricated: false,
    note: 'Only metrics derivable from the provided dataset are reported. Demand/growth/conversion statistics are never fabricated.',
  };
}

// ---------------------------------------------------------------------------
// Opportunity analysis (§13 — bounded, no win guarantee)
// ---------------------------------------------------------------------------

/** Opportunity result for a freelancer/project pair (§13). */
export interface OpportunityResult {
  readonly dataSufficient: boolean;
  readonly strengths: readonly string[];
  readonly concerns: readonly string[];
  readonly fit: MarketplaceMatch;
  readonly recommendedNextAction: string;
  readonly noWinGuarantee: true;
}

/** AG-301 / marketplace intelligence — deterministic opportunity analysis. */
export function analyzeOpportunity(input: MarketplaceStructuredInput): OpportunityResult {
  const freelancer = input.freelancer;
  const project = input.project;
  if (freelancer === undefined || project === undefined) {
    return {
      dataSufficient: false,
      strengths: [],
      concerns: ['A freelancer profile and a project are both required.'],
      fit: analyzeMarketplaceMatch(input),
      recommendedNextAction:
        'Provide the freelancer profile and the project to analyze the opportunity.',
      noWinGuarantee: true,
    };
  }
  const match = analyzeMarketplaceMatch(input);
  const strengths: string[] = [];
  const concerns: string[] = [];
  if (match.matchedSkills.length > 0) {
    strengths.push(
      `Matches ${match.matchedSkills.length} required skill${match.matchedSkills.length === 1 ? '' : 's'}: ${match.matchedSkills.slice(0, 3).join(', ')}${match.matchedSkills.length > 3 ? ', …' : ''}.`,
    );
  }
  if (
    hasText(freelancer.category) &&
    hasText(project.category) &&
    freelancer.category!.toLowerCase() === project.category!.toLowerCase()
  ) {
    strengths.push(`Category aligns with the project (${freelancer.category}).`);
  }
  if ((freelancer.experience?.years ?? 0) > 0) {
    strengths.push(
      `Declares ${freelancer.experience!.years} year${freelancer.experience!.years === 1 ? '' : 's'} of experience.`,
    );
  }
  if (hasText(freelancer.portfolioUrl)) {
    strengths.push('A portfolio is linked for verification.');
  }
  if (match.missingSkills.length > 0) {
    concerns.push(
      `Missing required skill${match.missingSkills.length === 1 ? '' : 's'}: ${match.missingSkills.slice(0, 3).join(', ')}${match.missingSkills.length > 3 ? ', …' : ''}.`,
    );
  }
  if (freelancer.hourlyRate !== undefined && hasBudgetRange(project)) {
    const max = project.budget!.max ?? project.budget!.min;
    if (max !== undefined && freelancer.hourlyRate > max) {
      concerns.push(
        'The declared hourly rate exceeds the project budget ceiling on its own — affordability may be a concern (needs clarification, not a rejection).',
      );
    }
  }
  if (!hasText(freelancer.portfolioUrl)) {
    concerns.push('No portfolio link is present for verification.');
  }

  const recommendedNextAction =
    match.score >= 70
      ? 'Apply with a proposal that highlights the matched skills and the verified portfolio.'
      : match.score >= 40
        ? 'Strengthen the profile around the missing skills, then apply and address them explicitly.'
        : 'Re-evaluate the opportunity — the skill gap is significant against the provided project.';

  return {
    dataSufficient: true,
    strengths: strengths.slice(0, 4),
    concerns: concerns.slice(0, 4),
    fit: match,
    recommendedNextAction,
    noWinGuarantee: true,
  };
}

// ---------------------------------------------------------------------------
// AG-301 — Contract Generator (catalog §12, F13)
// ---------------------------------------------------------------------------

/** Deterministic contract analysis result (outline-only, never legal advice). */
export interface ContractAnalysis {
  readonly blocked: boolean;
  readonly blockers: readonly string[];
  readonly status: 'draft-outline' | 'blocked' | 'insufficient data';
  readonly sections: readonly string[];
  readonly termsPresent: readonly string[];
  readonly missingTerms: readonly string[];
  readonly jurisdiction?: string;
  readonly fee?: number;
  readonly disclaimer: string;
  readonly generated: { readonly outline: boolean; readonly document: false };
}

/** AG-301 — block-on-missing-terms contract outline (deterministic). */
export function analyzeContract(input: MarketplaceStructuredInput): ContractAnalysis {
  const agreement = input.agreement;
  if (agreement === undefined) {
    return {
      blocked: false,
      blockers: [],
      status: 'insufficient data',
      sections: [],
      termsPresent: [],
      missingTerms: ['agreement'],
      disclaimer: DISCLAIMER,
      generated: { outline: true, document: false },
    };
  }
  const termsPresent: string[] = [];
  const missingTerms: string[] = [];
  if (hasText(agreement.parties?.clientId ?? agreement.parties?.clientName)) {
    termsPresent.push('client party');
  } else {
    missingTerms.push('client party');
  }
  if (hasText(agreement.parties?.freelancerId ?? agreement.parties?.freelancerName)) {
    termsPresent.push('freelancer party');
  } else {
    missingTerms.push('freelancer party');
  }
  const budgetPresent = agreement.budget?.min !== undefined || agreement.budget?.max !== undefined;
  if (budgetPresent || agreement.fee !== undefined) {
    termsPresent.push('payment terms');
  } else {
    missingTerms.push('payment terms');
  }
  if (agreement.milestones.length > 0) {
    termsPresent.push('milestones');
  } else {
    missingTerms.push('milestones');
  }
  if (agreement.terms.length > 0) {
    termsPresent.push('additional terms');
  }

  const missingMandatory = missingTerms.filter((term) =>
    ['client party', 'freelancer party', 'payment terms', 'milestones'].includes(term),
  );
  if (missingMandatory.length > 0) {
    return {
      blocked: true,
      blockers: missingMandatory.map(
        (term) => `Missing mandatory term: ${term} — generation is blocked.`,
      ),
      status: 'blocked',
      sections: [],
      termsPresent,
      missingTerms: missingMandatory,
      jurisdiction: agreement.jurisdiction,
      fee: agreement.fee,
      disclaimer: DISCLAIMER,
      generated: { outline: true, document: false },
    };
  }

  return {
    blocked: false,
    blockers: [],
    status: 'draft-outline',
    sections: [
      'Parties',
      'Scope of work',
      'Payment terms',
      'Milestones and deliverables',
      'Jurisdiction and dispute clauses',
    ],
    termsPresent,
    missingTerms: [],
    jurisdiction: agreement.jurisdiction,
    fee: agreement.fee,
    disclaimer: DISCLAIMER,
    generated: { outline: true, document: false },
  };
}

const DISCLAIMER =
  'This output is a structured draft outline, not legal advice. Have the final contract reviewed before signing.';

// ---------------------------------------------------------------------------
// AG-302 — Milestone Planner (catalog §12, F14, BR-ESC-1)
// ---------------------------------------------------------------------------

/** A proposed milestone within a deterministic plan. */
export interface PlannedMilestone {
  readonly title: string;
  readonly amount: number;
  readonly dueWeeks?: number;
  readonly deliverable?: string;
  readonly isEstimate: false;
}

/** Deterministic milestone plan with escrow-split enforcement (BR-ESC-1). */
export interface MilestonePlan {
  readonly dataSufficient: boolean;
  readonly milestones: readonly PlannedMilestone[];
  readonly proposedSplit: boolean;
  readonly escrowCompliant: boolean;
  readonly budgetTotal?: number;
  readonly milestoneSum?: number;
  readonly variance?: number;
  readonly blockers: readonly string[];
  readonly escrowRule: string;
  readonly requiresApproval: boolean;
}

/** AG-302 — propose/validate milestone plans (escrow rule enforced). */
export function planMilestones(input: MarketplaceStructuredInput): MilestonePlan {
  const agreement = input.agreement;
  const budgetTotal = agreement?.budget?.max ?? agreement?.budget?.min;
  const escrowRule =
    'Escrow-split rule: the sum of milestone amounts must equal the undertaking budget (BR-ESC-1).';
  if (agreement === undefined || budgetTotal === undefined) {
    return {
      dataSufficient: false,
      milestones: [],
      proposedSplit: false,
      escrowCompliant: false,
      blockers: ['Budget is missing — the escrow-split rule cannot be validated.'],
      escrowRule,
      requiresApproval: true,
    };
  }
  if (agreement.milestones.length === 0) {
    const split = 3;
    const unit = round2(budgetTotal / split);
    const remainder = round2(budgetTotal - unit * (split - 1));
    const milestones: PlannedMilestone[] = Array.from({ length: split }, (_, index) => ({
      title: `Milestone ${index + 1}`,
      amount: index === split - 1 ? remainder : unit,
      isEstimate: false,
    }));
    return {
      dataSufficient: true,
      milestones,
      proposedSplit: true,
      escrowCompliant: true,
      budgetTotal,
      milestoneSum: round2(milestones.reduce((sum, m) => sum + m.amount, 0)),
      variance: 0,
      blockers: [],
      escrowRule,
      requiresApproval: true,
    };
  }
  const sum = round2(agreement.milestones.reduce((total, m) => total + m.amount, 0));
  const variance = round2(sum - budgetTotal);
  const compliant = variance === 0;
  const milestones: PlannedMilestone[] = agreement.milestones.slice(0, 12).map((milestone) => ({
    title: milestone.title,
    amount: milestone.amount,
    dueWeeks: milestone.dueWeeks,
    deliverable: milestone.deliverable,
    isEstimate: false,
  }));
  return {
    dataSufficient: true,
    milestones,
    proposedSplit: false,
    escrowCompliant: compliant,
    budgetTotal,
    milestoneSum: sum,
    variance,
    blockers: compliant
      ? []
      : [
          `Sum of milestone amounts (${sum}) ≠ budget (${budgetTotal}) — validation block (BR-ESC-1).`,
        ],
    escrowRule,
    requiresApproval: true,
  };
}

// ---------------------------------------------------------------------------
// AG-303 — Review Generator (catalog §12, F12, BR-REV-1)
// ---------------------------------------------------------------------------

/** Deterministic, neutral review draft result (outline-only). */
export interface ReviewDraft {
  readonly dataSufficient: boolean;
  readonly sections: readonly string[];
  readonly factsObserved: readonly string[];
  readonly suggestedRating: number | null;
  readonly neutralTone: true;
  readonly retaliationFlag: boolean;
  readonly flagReason?: string;
  readonly requiresUserConfirmation: true;
  readonly generated: { readonly draft: false; readonly outline: boolean };
}

const RETALIATION_MARKERS = [
  'leave a review',
  'withdraw your review',
  'delete your review',
  'bad review if',
  'blackmail',
  'positive review in exchange',
];

/** AG-303 — neutral review draft from observed facts (nothing invented). */
export function generateReviewDraft(input: MarketplaceStructuredInput): ReviewDraft {
  const review = input.review;
  const hasFacts =
    review !== undefined &&
    review.engagementId !== undefined &&
    (review.messages.length > 0 ||
      review.deliveredOnTime !== undefined ||
      review.outcomeAgreed !== undefined ||
      hasText(review.qualityNotes));
  if (!hasFacts) {
    return {
      dataSufficient: false,
      sections: [],
      factsObserved: [],
      suggestedRating: null,
      neutralTone: true,
      retaliationFlag: false,
      requiresUserConfirmation: true,
      generated: { draft: false, outline: true },
    };
  }
  const factsObserved: string[] = [];
  if (review!.deliveredOnTime !== undefined) {
    factsObserved.push(
      review!.deliveredOnTime
        ? 'Delivery was on time (as reported).'
        : 'Delivery was late (as reported).',
    );
  }
  if (review!.outcomeAgreed !== undefined) {
    factsObserved.push(
      review!.outcomeAgreed ? 'Outcome was mutually agreed.' : 'Outcome was not mutually agreed.',
    );
  }
  if (review!.milestonesCount !== undefined) {
    factsObserved.push(
      `Engagement had ${review!.milestonesCount} milestone${review!.milestonesCount === 1 ? '' : 's'}.`,
    );
  }
  if (review!.messages.length > 0) {
    factsObserved.push(
      `Based on ${review!.messages.length} interaction record${review!.messages.length === 1 ? '' : 's'} provided.`,
    );
  }
  if (hasText(review!.qualityNotes)) {
    factsObserved.push('Reviewer-supplied quality notes are included in the draft.');
  }

  const flagged = RETALIATION_MARKERS.some((marker) =>
    review!.messages.some((message) => message.toLowerCase().includes(marker)),
  );
  let rating: number | null = null;
  if (review!.deliveredOnTime === true && review!.outcomeAgreed !== false) {
    rating = review!.milestonesCount !== undefined && review!.milestonesCount >= 1 ? 5 : 4;
  } else if (review!.deliveredOnTime === false) {
    rating = 2;
  } else if (review!.outcomeAgreed === true) {
    rating = 4;
  }

  return {
    dataSufficient: true,
    sections: [
      'Observed facts about the engagement',
      'Draft feedback (to be completed by the user)',
      'Suggested rating (awaiting user confirmation)',
    ],
    factsObserved: factsObserved.slice(0, 6),
    suggestedRating: rating,
    neutralTone: true,
    retaliationFlag: flagged,
    flagReason: flagged
      ? 'The provided interaction records contain review-coercion language; review is flagged for human moderation.'
      : undefined,
    requiresUserConfirmation: true,
    generated: { draft: false, outline: true },
  };
}

// ---------------------------------------------------------------------------
// AG-304 — Scam Detection (catalog §12, F15, AC-19)
// ---------------------------------------------------------------------------

/** A single deterministic risk finding. */
export interface RiskFinding {
  readonly code: string;
  readonly message: string;
}

/** Deterministic risk assessment from observed signals (evidence-based). */
export interface RiskAssessment {
  readonly dataSufficient: boolean;
  readonly score: number;
  readonly level: 'low' | 'medium' | 'high';
  readonly flags: readonly RiskFinding[];
  readonly evidence: readonly string[];
  readonly recommendation: string;
  readonly noAutoAction: true;
  readonly humanReview: boolean;
}

/** AG-304 — deterministic risk scoring; never an auto-ban. */
export function assessRisk(input: MarketplaceStructuredInput): RiskAssessment {
  const signals = input.signals;
  const message = input.message;
  const flags: RiskFinding[] = [];
  const evidence: string[] = [];
  let score = 0;

  const addFlag = (weight: number, code: string, messageText: string, evidenceText: string) => {
    flags.push({ code, message: messageText });
    evidence.push(evidenceText);
    score += weight;
  };

  if (signals?.paymentOutsidePlatform === true) {
    addFlag(
      30,
      'payment_outside_platform',
      'Payment is directed outside the platform.',
      'Observed signal: payment outside the platform.',
    );
  }
  if (signals?.contactOffPlatform === true) {
    addFlag(
      30,
      'contact_off_platform',
      'Off-platform contact is requested.',
      'Observed signal: off-platform contact.',
    );
  }
  if (signals?.urgencyPressure === true) {
    addFlag(
      15,
      'urgency_pressure',
      'Urgency pressure is present.',
      'Observed signal: urgency pressure.',
    );
  }
  if (signals?.suspiciousLink === true) {
    addFlag(
      15,
      'suspicious_link',
      'A suspicious link was shared.',
      'Observed signal: suspicious link.',
    );
  }
  if (signals?.newAccount === true) {
    addFlag(10, 'new_account', 'The counterparty account is new.', 'Observed signal: new account.');
  }
  if (signals?.reportedBefore === true) {
    addFlag(
      10,
      'reported_before',
      'The counterparty was reported before.',
      'Observed signal: prior report.',
    );
  }

  if (message !== undefined && message.body.length > 0) {
    const body = message.body.toLowerCase();
    if (containsEmailOrPhone(body)) {
      addFlag(
        15,
        'contact_off_platform',
        'The message shares off-platform contact details.',
        'Message shares an email address or phone number.',
      );
    }
    if (/http[s]?:\/\/|www\./i.test(body)) {
      addFlag(
        10,
        'external_link',
        'The message contains an external link.',
        'Message contains an external URL.',
      );
    }
  }

  if (flags.length === 0) {
    return {
      dataSufficient: false,
      score: 0,
      level: 'low',
      flags: [],
      evidence: ['No risk signals were provided for assessment.'],
      recommendation: 'No risk signal observed in the provided data.',
      noAutoAction: true,
      humanReview: false,
    };
  }

  const clamped = Math.min(100, score);
  const level = clamped < 30 ? 'low' : clamped < 60 ? 'medium' : 'high';
  const recommendation =
    level === 'low'
      ? 'No action required from the provided signals.'
      : level === 'medium'
        ? 'Hold and route for human review; no automatic action is taken.'
        : 'Elevate the evidence pack for admin review; no automatic ban is issued.';

  return {
    dataSufficient: true,
    score: clamped,
    level,
    flags: flags.slice(0, 8),
    evidence: evidence.slice(0, 8),
    recommendation,
    noAutoAction: true,
    humanReview: level !== 'low',
  };
}

function containsEmailOrPhone(value: string): boolean {
  return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(value) || /\+\d[\d\s-]{6,}\d/.test(value);
}

// ---------------------------------------------------------------------------
// AG-305 — Dispute Assistant (catalog §12, F16, AC-17/18, BR-DIS-3)
// ---------------------------------------------------------------------------

/** Deterministic dispute case analysis (recommendation only). */
export interface DisputeAnalysis {
  readonly dataSufficient: boolean;
  readonly caseSummary: readonly string[];
  readonly evidence: readonly string[];
  readonly resolutionOptions: readonly string[];
  readonly recommendation: string;
  readonly humanDecides: true;
  readonly noSubjectiveJudgement: true;
  readonly evidenceComplete: boolean;
}

/** AG-305 — compile a bounded case summary + evidence pack; human decides. */
export function analyzeDispute(input: MarketplaceStructuredInput): DisputeAnalysis {
  const dispute = input.dispute;
  if (dispute === undefined) {
    return {
      dataSufficient: false,
      caseSummary: [],
      evidence: [],
      resolutionOptions: RESOLUTION_OPTIONS,
      recommendation: 'Provide the dispute record to compile the case summary.',
      humanDecides: true,
      noSubjectiveJudgement: true,
      evidenceComplete: false,
    };
  }
  const caseSummary: string[] = [];
  if (hasText(dispute.reason)) {
    caseSummary.push(`Dispute reason provided: ${sanitizeMarketplaceText(dispute.reason!, 512)}.`);
  } else {
    caseSummary.push('No dispute reason was provided.');
  }
  if (hasText(dispute.openedAt)) {
    caseSummary.push(`Opened at: ${sanitizeMarketplaceText(dispute.openedAt!, 64)}.`);
  }
  caseSummary.push(
    `${dispute.messages.length} interaction record${dispute.messages.length === 1 ? '' : 's'} referenced.`,
  );
  caseSummary.push(
    `${dispute.deliverables.length} deliverable${dispute.deliverables.length === 1 ? '' : 's'} referenced.`,
  );
  caseSummary.push(
    `${dispute.payments.length} payment record${dispute.payments.length === 1 ? '' : 's'} referenced.`,
  );

  const evidence: string[] = [];
  for (const deliverable of dispute.deliverables.slice(0, 5)) {
    evidence.push(`Deliverable: ${sanitizeMarketplaceText(deliverable, 512)}`);
  }
  for (const payment of dispute.payments.slice(0, 5)) {
    evidence.push(`Payment record: ${payment} (amount; no party data exposed)`);
  }
  for (const message of dispute.messages.slice(0, 3)) {
    evidence.push(`Interaction record: ${sanitizeMarketplaceText(message, 512)}`);
  }

  const evidenceComplete =
    dispute.deliverables.length > 0 && dispute.payments.length > 0 && dispute.messages.length > 0;
  const recommendation = evidenceComplete
    ? 'Escalate the compiled evidence pack to admin for resolution.'
    : 'Collect deliverables, payment and interaction records before resolution. No judgment is issued.';

  return {
    dataSufficient: true,
    caseSummary: caseSummary.slice(0, 8),
    evidence: evidence.slice(0, 8),
    resolutionOptions: RESOLUTION_OPTIONS,
    recommendation,
    humanDecides: true,
    noSubjectiveJudgement: true,
    evidenceComplete,
  };
}

const RESOLUTION_OPTIONS: readonly string[] = Object.freeze([
  'negotiation',
  'mediation',
  'escalation to admin',
]);

// ---------------------------------------------------------------------------
// AG-306 — Messaging Assistant (catalog §12, F15 chat signal, F17 rail)
// ---------------------------------------------------------------------------

/** Deterministic message-filter result (on-platform enforcement, BR-MSG-4). */
export interface MessageFilter {
  readonly dataSufficient: boolean;
  readonly verdict: 'allow' | 'hold' | 'block';
  readonly appliedPolicies: readonly string[];
  readonly riskSignals: readonly string[];
  readonly supportSuggestions: readonly string[];
  readonly onPlatformOnly: true;
  readonly note: string;
}

const OFF_PLATFORM_CHANNELS = ['discord', 'telegram', 'whatsapp', 'signal', 'skype'];
const URGENCY_TERMS = ['urgent', 'immediately', 'today only', 'asap', 'quick response needed'];

/** AG-306 — filter inbound marketplace messages (fail-closed on uncertainty). */
export function filterMessage(input: MarketplaceStructuredInput): MessageFilter {
  const message = input.message;
  if (message === undefined || message.body.trim().length === 0) {
    return {
      dataSufficient: false,
      verdict: 'hold',
      appliedPolicies: [],
      riskSignals: [],
      supportSuggestions: ['Attach a message body to run filtering.'],
      onPlatformOnly: true,
      note: 'Empty message — held without judgment.',
    };
  }
  const body = sanitizeMarketplaceText(message.body, MARKETPLACE_DEFAULT_LIMITS.maxMessageBytes);
  const lower = body.toLowerCase();
  const riskSignals: string[] = [];
  if (containsEmailOrPhone(lower)) {
    riskSignals.push('contact-off-platform');
  }
  if (/http[s]?:\/\/|www\./i.test(lower)) {
    riskSignals.push('external-link');
  }
  for (const channel of OFF_PLATFORM_CHANNELS) {
    if (lower.includes(channel)) {
      riskSignals.push(`off-platform-channel-${channel}`);
    }
  }
  if (URGENCY_TERMS.some((term) => lower.includes(term))) {
    riskSignals.push('urgency-pressure');
  }
  if (
    /(pay[^.]{0,40}\boutside|send[^.]{0,40}\bbank|pay[^.]{0,40}\b(bank|venmo|cashapp))/i.test(lower)
  ) {
    riskSignals.push('payment-outside-platform');
  }

  const appliedPolicies = [
    'on-platform communication required (BR-MSG-4)',
    'off-platform solicitation screened',
    'payment methods kept on-platform',
  ];

  const verdict: MessageFilter['verdict'] = riskSignals.includes('payment-outside-platform')
    ? 'block'
    : riskSignals.includes('contact-off-platform') || riskSignals.length >= 2
      ? 'hold'
      : 'allow';

  const supportSuggestions =
    verdict === 'allow'
      ? ['Engage on-platform only; the platform guarantees secure payments.']
      : verdict === 'hold'
        ? [
            'This message was held for human review — off-platform contact may put the engagement at risk.',
            'Keep all discussions and payments on the platform.',
          ]
        : [
            'This message was blocked: on-platform payment rules prohibit moving payments off the platform.',
            'Contact support to review the policy decision.',
          ];

  return {
    dataSufficient: true,
    verdict,
    appliedPolicies,
    riskSignals: dedupe(riskSignals).slice(0, 6),
    supportSuggestions: supportSuggestions.slice(0, 3),
    onPlatformOnly: true,
    note: 'Filtering is deterministic policy screening; uncertainty holds the message for human review.',
  };
}

// ---------------------------------------------------------------------------
// Runtime agents
// ---------------------------------------------------------------------------

const DEP = (id: string) => ({ type: DependencyType.Agent, id, required: false });

function marketplaceCapabilities(ids: readonly string[]): readonly AgentCapability[] {
  return Object.freeze(ids.map((id) => ({ id, name: id, enabled: true })));
}

/** A deterministic per-capability analyzer shared by the runtime agents. */
type MarketplaceAnalyzer = (
  capabilityId: string,
  input: MarketplaceStructuredInput,
) => {
  readonly output: Readonly<Record<string, unknown>>;
  readonly recommendations: readonly unknown[];
};

interface MarketplaceAgentConfig {
  readonly agentId: string;
  readonly name: string;
  readonly category: AgentCategory;
  readonly status: AgentStatus;
  readonly capabilities: readonly string[];
  readonly dependencies: readonly string[];
  readonly maxTokens: number;
}

function createMarketplaceAgent(config: MarketplaceAgentConfig): RuntimeAgent {
  const { agentId } = config;
  return {
    configuration: {
      agentId,
      name: config.name,
      version: MARKETPLACE_TEAM_VERSION,
      category: config.category,
      status: config.status,
      capabilities: marketplaceCapabilities(config.capabilities),
      dependencies: Object.freeze(config.dependencies.map(DEP)),
      limits: { maxTokens: config.maxTokens, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const delay = clampDelay(parseNumber(context.inputs['marketplace.delayMs'], 0));
      if (delay > 0) {
        await wait(delay, context);
      }
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractMarketplaceInput(context.inputs);
      const capabilityId = resolveCapability(
        agentId,
        config.capabilities,
        context.inputs['marketplace.capability'],
      );
      const { output, recommendations } = dispatchAnalyzer(agentId, capabilityId, input);
      return {
        success: true,
        output: {
          ...output,
          recommendations,
        },
        metadata: { provider: 'runtime', agentId, version: MARKETPLACE_TEAM_VERSION },
      };
    },
  };
}

/** Picks the requested capability when the agent advertises it; else primary. */
function resolveCapability(
  agentId: string,
  allowed: readonly string[],
  requested: unknown,
): string {
  if (typeof requested === 'string' && requested.length > 0 && allowed.includes(requested)) {
    return requested;
  }
  return defaultCapabilityFor(agentId);
}

// ---------------------------------------------------------------------------
// Capability-aware analyzer dispatch (per-capability deterministic agents)
// ---------------------------------------------------------------------------

/** Result key used per capability in agent output. */
export const MARKETPLACE_CAPABILITY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  [MARKETPLACE_CAPABILITY_IDS.contractGenerate]: 'contract',
  [MARKETPLACE_CAPABILITY_IDS.projectQuality]: 'quality',
  [MARKETPLACE_CAPABILITY_IDS.opportunityAnalyze]: 'opportunity',
  [MARKETPLACE_CAPABILITY_IDS.milestonePlan]: 'milestones',
  [MARKETPLACE_CAPABILITY_IDS.budgetAnalyze]: 'budget',
  [MARKETPLACE_CAPABILITY_IDS.reviewGenerate]: 'review',
  [MARKETPLACE_CAPABILITY_IDS.scamReport]: 'risk',
  [MARKETPLACE_CAPABILITY_IDS.marketplaceInsights]: 'insights',
  [MARKETPLACE_CAPABILITY_IDS.marketplaceDiscovery]: 'discovery',
  [MARKETPLACE_CAPABILITY_IDS.disputeOpen]: 'dispute',
  [MARKETPLACE_CAPABILITY_IDS.messageSend]: 'message',
});

function wrapOutput(
  capabilityId: string,
  result: Record<string, unknown>,
  recommendations: readonly unknown[],
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const key = MARKETPLACE_CAPABILITY_KEYS[capabilityId] ?? 'result';
  return { output: { [key]: result[key] ?? result }, recommendations };
}

function analyzeContractOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const contract = analyzeContract(input);
  return wrapOutput(capabilityId, { contract }, contract.blockers.length > 0 ? [] : []);
}

function analyzeProjectQualityOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const quality = analyzeProjectQuality(input);
  const recommendations =
    quality.recommendations.length > 0
      ? [{ recommendation: quality.recommendations[0] }]
      : quality.status === 'complete'
        ? [{ recommendation: 'Project quality checks passed with the provided data.' }]
        : [];
  return wrapOutput(capabilityId, { quality }, recommendations);
}

function analyzeOpportunityOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const opportunity = analyzeOpportunity(input);
  const recommendations = opportunity.dataSufficient
    ? [{ recommendation: opportunity.recommendedNextAction }]
    : opportunity.concerns.map((concern) => ({ recommendation: concern }));
  return wrapOutput(capabilityId, { opportunity }, recommendations);
}

function analyzeMilestoneOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const milestones = planMilestones(input);
  const recommendations = milestones.blockers.map((blocker) => ({ recommendation: blocker }));
  return wrapOutput(capabilityId, { milestones }, recommendations);
}

function analyzeBudgetOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const budget = analyzeBudget(input);
  const recommendations = budget.concerns.map((concern) => ({ recommendation: concern }));
  return wrapOutput(capabilityId, { budget }, recommendations);
}

function analyzeReviewOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const review = generateReviewDraft(input);
  const recommendations: unknown[] = [];
  if (review.dataSufficient) {
    recommendations.push({
      recommendation: 'Confirm and edit the draft before posting; reviews are never auto-posted.',
    });
    if (review.retaliationFlag) {
      recommendations.push({
        recommendation: review.flagReason ?? 'Flagged for human moderation.',
      });
    }
  }
  return wrapOutput(capabilityId, { review }, recommendations);
}

function analyzeRiskOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const risk = assessRisk(input);
  const recommendations = risk.dataSufficient ? [{ recommendation: risk.recommendation }] : [];
  return wrapOutput(capabilityId, { risk }, recommendations);
}

function analyzeInsightsOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const insights = computeMarketplaceInsights(input);
  const recommendations = insights.recommendations.map((recommendation) => ({
    recommendation,
  }));
  return wrapOutput(capabilityId, { insights }, recommendations);
}

function analyzeDiscoveryOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const discovery = discoverMarketplaceProjects(input);
  const recommendations = discovery.discovered.slice(0, 2).map((entry) => ({
    recommendation: `${entry.title ?? 'A project'} scores ${entry.fitScore}/100 with the provided profile.`,
  }));
  return wrapOutput(capabilityId, { discovery }, recommendations);
}

function analyzeDisputeOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const dispute = analyzeDispute(input);
  const recommendations = [{ recommendation: dispute.recommendation }];
  return wrapOutput(capabilityId, { dispute }, recommendations);
}

function analyzeMessageOutput(
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const message = filterMessage(input);
  const recommendations = message.supportSuggestions.map((recommendation) => ({ recommendation }));
  return wrapOutput(capabilityId, { message }, recommendations);
}

/** Full capability → analyzer dispatch used by all create* agents. */
const MARKETPLACE_ANALYZERS: Readonly<Record<string, MarketplaceAnalyzer>> = Object.freeze({
  [MARKETPLACE_CAPABILITY_IDS.contractGenerate]: analyzeContractOutput,
  [MARKETPLACE_CAPABILITY_IDS.projectQuality]: analyzeProjectQualityOutput,
  [MARKETPLACE_CAPABILITY_IDS.opportunityAnalyze]: analyzeOpportunityOutput,
  [MARKETPLACE_CAPABILITY_IDS.milestonePlan]: analyzeMilestoneOutput,
  [MARKETPLACE_CAPABILITY_IDS.budgetAnalyze]: analyzeBudgetOutput,
  [MARKETPLACE_CAPABILITY_IDS.reviewGenerate]: analyzeReviewOutput,
  [MARKETPLACE_CAPABILITY_IDS.scamReport]: analyzeRiskOutput,
  [MARKETPLACE_CAPABILITY_IDS.marketplaceInsights]: analyzeInsightsOutput,
  [MARKETPLACE_CAPABILITY_IDS.marketplaceDiscovery]: analyzeDiscoveryOutput,
  [MARKETPLACE_CAPABILITY_IDS.disputeOpen]: analyzeDisputeOutput,
  [MARKETPLACE_CAPABILITY_IDS.messageSend]: analyzeMessageOutput,
});

/** AG-301 — Contract Generator (contracts + project quality + opportunity). */
export function createContractGeneratorAgent(): RuntimeAgent {
  const agentId = MARKETPLACE_AGENT_IDS.contractGenerator;
  return createMarketplaceAgent({
    agentId,
    name: 'Contract Generator',
    category: AgentCategory.Marketplace,
    status: AgentStatus.Draft,
    capabilities: [
      MARKETPLACE_CAPABILITY_IDS.contractGenerate,
      MARKETPLACE_CAPABILITY_IDS.projectQuality,
      MARKETPLACE_CAPABILITY_IDS.opportunityAnalyze,
    ],
    dependencies: [MARKETPLACE_AGENT_IDS.milestonePlanner],
    maxTokens: 6000,
  });
}

/** AG-302 — Milestone Planner (milestones + budget intelligence). */
export function createMilestonePlannerAgent(): RuntimeAgent {
  const agentId = MARKETPLACE_AGENT_IDS.milestonePlanner;
  return createMarketplaceAgent({
    agentId,
    name: 'Milestone Planner',
    category: AgentCategory.Marketplace,
    status: AgentStatus.Draft,
    capabilities: [
      MARKETPLACE_CAPABILITY_IDS.milestonePlan,
      MARKETPLACE_CAPABILITY_IDS.budgetAnalyze,
    ],
    dependencies: [],
    maxTokens: 6000,
  });
}

/** AG-303 — Review Generator (neutral review drafts). */
export function createReviewGeneratorAgent(): RuntimeAgent {
  const agentId = MARKETPLACE_AGENT_IDS.reviewGenerator;
  return createMarketplaceAgent({
    agentId,
    name: 'Review Generator',
    category: AgentCategory.Marketplace,
    status: AgentStatus.Draft,
    capabilities: [MARKETPLACE_CAPABILITY_IDS.reviewGenerate],
    dependencies: [],
    maxTokens: 4000,
  });
}

/** AG-304 — Scam Detection (risk + insights + discovery analytics). */
export function createScamDetectorAgent(): RuntimeAgent {
  const agentId = MARKETPLACE_AGENT_IDS.scamDetector;
  return createMarketplaceAgent({
    agentId,
    name: 'Scam Detection',
    category: AgentCategory.Marketplace,
    status: AgentStatus.InDevelopment,
    capabilities: [
      MARKETPLACE_CAPABILITY_IDS.scamReport,
      MARKETPLACE_CAPABILITY_IDS.marketplaceInsights,
      MARKETPLACE_CAPABILITY_IDS.marketplaceDiscovery,
    ],
    dependencies: [],
    maxTokens: 4000,
  });
}

/** AG-305 — Dispute Assistant (case summaries; human decides). */
export function createDisputeAssistantAgent(): RuntimeAgent {
  const agentId = MARKETPLACE_AGENT_IDS.disputeAssistant;
  return createMarketplaceAgent({
    agentId,
    name: 'Dispute Assistant',
    category: AgentCategory.Marketplace,
    status: AgentStatus.Draft,
    capabilities: [MARKETPLACE_CAPABILITY_IDS.disputeOpen],
    dependencies: [MARKETPLACE_AGENT_IDS.reviewGenerator, MARKETPLACE_AGENT_IDS.contractGenerator],
    maxTokens: 4000,
  });
}

/** AG-306 — Messaging Assistant (policy filtering → risk signals). */
export function createMessagingAssistantAgent(): RuntimeAgent {
  const agentId = MARKETPLACE_AGENT_IDS.messagingAssistant;
  return createMarketplaceAgent({
    agentId,
    name: 'Messaging Assistant',
    category: AgentCategory.Marketplace,
    status: AgentStatus.InDevelopment,
    capabilities: [MARKETPLACE_CAPABILITY_IDS.messageSend],
    dependencies: [MARKETPLACE_AGENT_IDS.scamDetector],
    maxTokens: 4000,
  });
}

/** All marketplace-team runtime agents introduced by this module. */
export function createMarketplaceTeamAgents(): readonly RuntimeAgent[] {
  return [
    createContractGeneratorAgent(),
    createMilestonePlannerAgent(),
    createReviewGeneratorAgent(),
    createScamDetectorAgent(),
    createDisputeAssistantAgent(),
    createMessagingAssistantAgent(),
  ];
}

/** Dispatches to the analyzer for the selected capability (or primary fallback). */
function dispatchAnalyzer(
  agentId: string,
  capabilityId: string,
  input: MarketplaceStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const resolver = MARKETPLACE_ANALYZERS[capabilityId];
  if (resolver === undefined) {
    throw new Error(`No marketplace analyzer for capability ${capabilityId} on ${agentId}`);
  }
  return resolver(capabilityId, input);
}

function defaultCapabilityFor(agentId: string): string {
  switch (agentId) {
    case MARKETPLACE_AGENT_IDS.contractGenerator:
      return MARKETPLACE_CAPABILITY_IDS.contractGenerate;
    case MARKETPLACE_AGENT_IDS.milestonePlanner:
      return MARKETPLACE_CAPABILITY_IDS.milestonePlan;
    case MARKETPLACE_AGENT_IDS.reviewGenerator:
      return MARKETPLACE_CAPABILITY_IDS.reviewGenerate;
    case MARKETPLACE_AGENT_IDS.scamDetector:
      return MARKETPLACE_CAPABILITY_IDS.scamReport;
    case MARKETPLACE_AGENT_IDS.disputeAssistant:
      return MARKETPLACE_CAPABILITY_IDS.disputeOpen;
    case MARKETPLACE_AGENT_IDS.messagingAssistant:
      return MARKETPLACE_CAPABILITY_IDS.messageSend;
    default:
      throw new Error(`Unknown marketplace agent ${agentId}`);
  }
}

// ---------------------------------------------------------------------------
// Platform mirror definitions
// ---------------------------------------------------------------------------

/**
 * Platform mirror definitions for the marketplace runtime agents
 * (AG-301..AG-306). Tool access is an explicit policy layer on top: every
 * marketplace agent ships v1 with an empty allowlist (fail-closed), so
 * agentic tool calling is refused until a tool is explicitly enabled.
 */
export function createMarketplaceTeamAgentDefinitions(): readonly AgentDefinition[] {
  const limits = {
    maxExecutionTimeMs: 60_000,
    maxReasoningTurns: 0,
    maxToolCalls: 0,
    maxContextBytes: 32_768,
    maxOutputBytes: 32_768,
    maxConcurrentExecutions: 2,
  };
  return [
    {
      agentId: MARKETPLACE_AGENT_IDS.contractGenerator,
      name: 'Contract Generator',
      version: MARKETPLACE_TEAM_VERSION,
      description:
        'Drafts milestone-based contract outlines from agreed terms and blocks on missing mandatory terms (deterministic v1).',
      team: MARKETPLACE_TEAM_GROUP,
      category: AgentCategory.Marketplace,
      status: AgentStatus.Draft,
      capabilities: [
        capability(MARKETPLACE_CAPABILITY_IDS.contractGenerate),
        capability(MARKETPLACE_CAPABILITY_IDS.projectQuality),
        capability(MARKETPLACE_CAPABILITY_IDS.opportunityAnalyze),
      ],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: [
        'knowledge.read',
        MARKETPLACE_CAPABILITY_IDS.contractGenerate,
        MARKETPLACE_CAPABILITY_IDS.projectQuality,
        MARKETPLACE_CAPABILITY_IDS.opportunityAnalyze,
      ],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: MARKETPLACE_AGENT_IDS.milestonePlanner,
          required: false,
        },
      ],
      configuration: {},
    },
    {
      agentId: MARKETPLACE_AGENT_IDS.milestonePlanner,
      name: 'Milestone Planner',
      version: MARKETPLACE_TEAM_VERSION,
      description:
        'Proposes milestone/escrow splits and validates that milestone sums equal the budget (deterministic v1, BR-ESC-1).',
      team: MARKETPLACE_TEAM_GROUP,
      category: AgentCategory.Marketplace,
      status: AgentStatus.Draft,
      capabilities: [
        capability(MARKETPLACE_CAPABILITY_IDS.milestonePlan),
        capability(MARKETPLACE_CAPABILITY_IDS.budgetAnalyze),
      ],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: [
        'knowledge.read',
        MARKETPLACE_CAPABILITY_IDS.milestonePlan,
        MARKETPLACE_CAPABILITY_IDS.budgetAnalyze,
      ],
      limits,
      dependencies: [],
      configuration: {},
    },
    {
      agentId: MARKETPLACE_AGENT_IDS.reviewGenerator,
      name: 'Review Generator',
      version: MARKETPLACE_TEAM_VERSION,
      description:
        'Drafts neutral review outlines from observed engagement facts with a suggested rating and user confirmation (deterministic v1).',
      team: MARKETPLACE_TEAM_GROUP,
      category: AgentCategory.Marketplace,
      status: AgentStatus.Draft,
      capabilities: [capability(MARKETPLACE_CAPABILITY_IDS.reviewGenerate)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', MARKETPLACE_CAPABILITY_IDS.reviewGenerate],
      limits,
      dependencies: [],
      configuration: {},
    },
    {
      agentId: MARKETPLACE_AGENT_IDS.scamDetector,
      name: 'Scam Detection',
      version: MARKETPLACE_TEAM_VERSION,
      description:
        'Assesses risk from observed signals, surfaces marketplace insights and ranks provided projects (deterministic v1, no auto-actions).',
      team: MARKETPLACE_TEAM_GROUP,
      category: AgentCategory.Marketplace,
      status: AgentStatus.InDevelopment,
      capabilities: [
        capability(MARKETPLACE_CAPABILITY_IDS.scamReport),
        capability(MARKETPLACE_CAPABILITY_IDS.marketplaceInsights),
        capability(MARKETPLACE_CAPABILITY_IDS.marketplaceDiscovery),
      ],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: [
        'knowledge.read',
        MARKETPLACE_CAPABILITY_IDS.scamReport,
        MARKETPLACE_CAPABILITY_IDS.marketplaceInsights,
        MARKETPLACE_CAPABILITY_IDS.marketplaceDiscovery,
      ],
      limits,
      dependencies: [],
      configuration: {},
    },
    {
      agentId: MARKETPLACE_AGENT_IDS.disputeAssistant,
      name: 'Dispute Assistant',
      version: MARKETPLACE_TEAM_VERSION,
      description:
        'Compiles dispute case summaries and evidence packs; recommendation only, humans decide (deterministic v1, BR-DIS-3).',
      team: MARKETPLACE_TEAM_GROUP,
      category: AgentCategory.Marketplace,
      status: AgentStatus.Draft,
      capabilities: [capability(MARKETPLACE_CAPABILITY_IDS.disputeOpen)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', MARKETPLACE_CAPABILITY_IDS.disputeOpen],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: MARKETPLACE_AGENT_IDS.reviewGenerator,
          required: false,
        },
        {
          type: DependencyType.Agent,
          id: MARKETPLACE_AGENT_IDS.contractGenerator,
          required: false,
        },
      ],
      configuration: {},
    },
    {
      agentId: MARKETPLACE_AGENT_IDS.messagingAssistant,
      name: 'Messaging Assistant',
      version: MARKETPLACE_TEAM_VERSION,
      description:
        'Filters inbound marketplace messages with on-platform policy and routes risk signals to scam detection (deterministic v1).',
      team: MARKETPLACE_TEAM_GROUP,
      category: AgentCategory.Marketplace,
      status: AgentStatus.InDevelopment,
      capabilities: [capability(MARKETPLACE_CAPABILITY_IDS.messageSend)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', MARKETPLACE_CAPABILITY_IDS.messageSend],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: MARKETPLACE_AGENT_IDS.scamDetector,
          required: false,
        },
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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

function asNumberArray(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item),
  );
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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asBudget(value: unknown): { readonly min?: number; readonly max?: number } | undefined {
  const object = asObject(value);
  if (object === undefined) {
    return undefined;
  }
  return {
    min: asFiniteNumber(object['min']),
    max: asFiniteNumber(object['max']),
  };
}

function asTimeline(
  value: unknown,
): { readonly weeksMin?: number; readonly weeksMax?: number } | undefined {
  const object = asObject(value);
  if (object === undefined) {
    return undefined;
  }
  return {
    weeksMin: asFiniteNumber(object['weeksMin']),
    weeksMax: asFiniteNumber(object['weeksMax']),
  };
}

function asMilestoneArray(
  value: unknown,
):
  | readonly { readonly title: string; readonly amount: number; readonly dueWeeks?: number }[]
  | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map(asObject)
    .filter((entry): entry is { readonly [key: string]: unknown } => entry !== undefined)
    .map((entry) => ({
      title: asString(entry['title']) ?? '',
      amount: asFiniteNumber(entry['amount']) ?? 0,
      dueWeeks: asFiniteNumber(entry['dueWeeks']),
      deliverable: asString(entry['deliverable']),
    }))
    .filter((milestone) => milestone.title.length > 0 && milestone.amount > 0);
  return items.length > 0 ? items : undefined;
}

function sanitizeOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const sanitized = sanitizeMarketplaceText(value, 16_384);
  return sanitized.length === 0 ? undefined : sanitized;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasBudgetRange(project: NonNullable<MarketplaceStructuredInput['project']>): boolean {
  return project.budget?.min !== undefined || project.budget?.max !== undefined;
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
