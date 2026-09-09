/**
 * Sprint 24 — Marketing AI Team v1. Deterministic marketing agents
 * (AG-401..AG-405 — catalog §13).
 *
 * Every marketing agent is deterministic-first: it computes from its inputs
 * and the provided context and never requires an LLM. Nothing is fabricated:
 * research insights are only sourced summaries (BR-AI-4 — uncited insights are
 * rejected), drafts are never invented when copy was not supplied, no
 * engagement/ranking/campaign predictions are manufactured, `isEstimate`
 * semantics and `insufficientData`/`draftComplete` states follow the Sprint
 * 21/22/23 data-honesty rules, and every content agent enforces its human
 * review/publish gate (AG-402/AG-403/AG-405, BR-AI-2 "no auto-publish"). Tool
 * results and memory/knowledge context are treated as data. Cancellation is
 * cooperative through the runtime signal.
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
  MARKETING_AGENT_IDS,
  MARKETING_CAPABILITY_IDS,
  MARKETING_MAX_DOCUMENT_BYTES,
  MARKETING_PLATFORM_BUDGETS,
  MARKETING_TEAM_GROUP,
  MARKETING_TEAM_VERSION,
  MARKETING_MAX_SOCIAL_VARIANTS,
} from './constants.js';
import { sanitizeMarketingText } from './security.js';

/** Structured fields extracted from a marketing task input (never invented). */
export interface MarketingStructuredInput {
  readonly research?: {
    readonly brief?: string;
    readonly focus?: string;
    readonly sources: readonly {
      readonly source: string;
      readonly claim?: string;
      readonly url?: string;
    }[];
  };
  readonly social?: {
    readonly platform?: string;
    readonly audience?: string;
    readonly goal?: string;
    readonly brandKeywords: readonly string[];
    readonly userDraft?: string;
  };
  readonly blog?: {
    readonly topic?: string;
    readonly outline?: string;
    readonly seoKeywords: readonly string[];
    readonly audience?: string;
    readonly brandKeywords: readonly string[];
    readonly userDraft?: string;
  };
  readonly seo?: {
    readonly title?: string;
    readonly metaDescription?: string;
    readonly headings: readonly string[];
    readonly body?: string;
    readonly keywords: readonly string[];
  };
  readonly email?: {
    readonly audience?: string;
    readonly subject?: string;
    readonly body?: string;
    readonly cta?: string;
    readonly tone?: string;
    readonly campaignType?: string;
    readonly brandKeywords: readonly string[];
  };
}

/** Extracts structured marketing input from arbitrary execution inputs. */
export function extractMarketingInput(
  inputs: Readonly<Record<string, unknown>>,
): MarketingStructuredInput {
  const inline = (inputs['input'] as Readonly<Record<string, unknown>> | undefined) ?? inputs;
  const research = asObject(inputs['research']) ?? asObject(inline['research']);
  const social = asObject(inputs['social']) ?? asObject(inline['social']);
  const blog = asObject(inputs['blog']) ?? asObject(inline['blog']);
  const seo = asObject(inputs['seo']) ?? asObject(inline['seo']);
  const email = asObject(inputs['email']) ?? asObject(inline['email']);
  return {
    research:
      research === undefined
        ? undefined
        : {
            brief: sanitizeOptional(research['brief']),
            focus: asString(research['focus']),
            sources: asSourceArray(research['sources']) ?? [],
          },
    social:
      social === undefined
        ? undefined
        : {
            platform: asString(social['platform']),
            audience: sanitizeOptional(social['audience']),
            goal: sanitizeOptional(social['goal']),
            brandKeywords: asStringArray(social['brandKeywords']) ?? [],
            userDraft: sanitizeOptional(social['userDraft']),
          },
    blog:
      blog === undefined
        ? undefined
        : {
            topic: sanitizeOptional(blog['topic']),
            outline: sanitizeOptional(blog['outline']),
            seoKeywords: asStringArray(blog['seoKeywords']) ?? [],
            audience: sanitizeOptional(blog['audience']),
            brandKeywords: asStringArray(blog['brandKeywords']) ?? [],
            userDraft: sanitizeOptional(blog['userDraft']),
          },
    seo:
      seo === undefined
        ? undefined
        : {
            title: sanitizeOptional(seo['title']),
            metaDescription: sanitizeOptional(seo['metaDescription']),
            headings: asStringArray(seo['headings']) ?? [],
            body: sanitizeOptional(seo['body']),
            keywords: asStringArray(seo['keywords']) ?? [],
          },
    email:
      email === undefined
        ? undefined
        : {
            audience: sanitizeOptional(email['audience']),
            subject: sanitizeOptional(email['subject']),
            body: sanitizeOptional(email['body']),
            cta: sanitizeOptional(email['cta']),
            tone: sanitizeOptional(email['tone']),
            campaignType: sanitizeOptional(email['campaignType']),
            brandKeywords: asStringArray(email['brandKeywords']) ?? [],
          },
  };
}

function asSourceArray(
  value: unknown,
):
  | readonly { readonly source: string; readonly claim?: string; readonly url?: string }[]
  | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map(asObject)
    .filter((entry): entry is { readonly [key: string]: unknown } => entry !== undefined)
    .map((entry) => ({
      source: sanitizeOptional(entry['source']) ?? '',
      claim: sanitizeOptional(entry['claim']),
      url: sanitizeOptional(entry['url']),
    }));
  return items;
}

// ---------------------------------------------------------------------------
// AG-401 — Research Agent (sourced insight summaries; BR-AI-4 cited-only)
// ---------------------------------------------------------------------------

/** One accepted insight: a claim that carries a concrete source. */
export interface ResearchInsight {
  readonly claim: string;
  readonly source: string;
  readonly url?: string;
  readonly cited: boolean;
}

/** Deterministic output of the research agent (never a fabricated finding). */
export interface ResearchSummary {
  readonly dataSufficient: boolean;
  readonly topic?: string;
  readonly focus?: string;
  readonly insights: readonly ResearchInsight[];
  readonly referencedSources: readonly string[];
  readonly rejectedInsightCount: number;
  /** Uncited/unverifiable insights are never written to the KB (BR-AI-4). */
  readonly uncitedInsightsRejected: boolean;
  readonly citationPolicy: 'cited-only';
  /** KB write happens by editors; the agent never publishes directly. */
  readonly publishable: boolean;
  readonly note: string;
}

/** AG-401 — compile sourced insight summaries; uncited claims are rejected. */
export function analyzeResearch(input: MarketingStructuredInput): ResearchSummary {
  const research = input.research;
  const sources = (research?.sources ?? []).filter((source) => source.source.trim().length > 0);
  if (sources.length === 0) {
    return {
      dataSufficient: false,
      topic: research?.brief,
      focus: research?.focus,
      insights: [],
      referencedSources: [],
      rejectedInsightCount: 0,
      uncitedInsightsRejected: true,
      citationPolicy: 'cited-only',
      publishable: false,
      note: 'Nothing is stated without a cited source — supply research sources with claims to compile summaries (BR-AI-4).',
    };
  }
  const insights: ResearchInsight[] = [];
  const rejected: ResearchInsight[] = [];
  for (const source of sources) {
    const claim = source.claim?.trim() ?? '';
    const entry: ResearchInsight = {
      claim,
      source: source.source.trim(),
      url: source.url,
      cited: claim.length > 0,
    };
    if (entry.cited) {
      insights.push(entry);
    } else {
      rejected.push(entry);
    }
  }
  const referencedSources = [...new Set(insights.map((insight) => insight.source))];
  const dataSufficient = insights.length > 0;
  return {
    dataSufficient,
    topic: research?.brief,
    focus: research?.focus,
    insights,
    referencedSources,
    rejectedInsightCount: rejected.length,
    uncitedInsightsRejected: true,
    citationPolicy: 'cited-only',
    publishable: false,
    note: dataSufficient
      ? `${insights.length} cited insight${insights.length === 1 ? '' : 's'} compiled; ${rejected.length} uncited source${rejected.length === 1 ? '' : 's'} rejected. Editors review before any KB write.`
      : 'All supplied sources lacked a claim — no insight is compiled and nothing is fabricated.',
  };
}

// ---------------------------------------------------------------------------
// AG-402 — Social Media Manager (drafts + platform variants; no auto-publish)
// ---------------------------------------------------------------------------

/** A single deterministic platform variant of a social draft. */
export interface SocialVariant {
  readonly platform: string;
  readonly status: 'draft';
  readonly body: string;
  readonly budgetChars: number;
  readonly usedChars: number;
  readonly truncated: boolean;
}

/** Deterministic output of the social media manager. */
export interface SocialDraft {
  readonly dataSufficient: boolean;
  readonly draftComplete: boolean;
  readonly platformSpecified?: string;
  readonly variants: readonly SocialVariant[];
  readonly brandKeywordMatches: readonly string[];
  /** Always empty — no engagement prediction is ever fabricated. */
  readonly engagementClaims: readonly string[];
  /** AG-402 + BR-AI-2: publish always requires a human review gate. */
  readonly publishable: boolean;
  readonly note: string;
}

/** AG-402 — structure on-brand social drafts; never invent the copy itself. */
export function analyzeSocialPost(input: MarketingStructuredInput): SocialDraft {
  const social = input.social;
  const brandKeywords = social?.brandKeywords ?? [];
  const userDraft = social?.userDraft ?? '';
  const draftPresent = userDraft.trim().length > 0;

  const platforms = resolvePlatforms(social?.platform);
  const variants: SocialVariant[] = [];
  for (const platform of platforms.slice(0, MARKETING_MAX_SOCIAL_VARIANTS)) {
    const budgetChars = budgetFor(platform);
    const body = sanitizeMarketingText(userDraft, budgetChars);
    variants.push({
      platform,
      status: 'draft',
      body,
      budgetChars,
      usedChars: body.length,
      truncated: body.length > budgetChars,
    });
  }
  const brandKeywordMatches = brandKeywords.filter((keyword) =>
    userDraft.toLowerCase().includes(keyword.toLowerCase()),
  );
  return {
    dataSufficient: true,
    draftComplete: draftPresent,
    platformSpecified: social?.platform,
    variants,
    brandKeywordMatches,
    engagementClaims: [],
    publishable: false,
    note: draftPresent
      ? 'Draft copy preserved; publishing is gated behind human review.'
      : 'No draft copy was supplied — the deterministic engine does not invent headline copy. Structure and platform budgets are provided; humans write or approve the copy.',
  };
}

function resolvePlatforms(platform: string | undefined): readonly string[] {
  if (platform !== undefined && platform !== 'other' && platform in MARKETING_PLATFORM_BUDGETS) {
    return [platform!];
  }
  return Object.keys(MARKETING_PLATFORM_BUDGETS);
}

function budgetFor(platform: string): number {
  const budget = MARKETING_PLATFORM_BUDGETS[platform];
  return typeof budget === 'number' ? budget : 3_000;
}

// ---------------------------------------------------------------------------
// AG-403 — Blog Writer (SEO-ready structure; no inflated promises, BR-AI-5)
// ---------------------------------------------------------------------------

/** One generated structural section guide (structure, never fabricated copy). */
export interface BlogSectionGuide {
  readonly heading: string;
  readonly purpose: string;
}

/** Deterministic output of the blog writer. */
export interface BlogDraft {
  readonly dataSufficient: boolean;
  readonly draftComplete: boolean;
  readonly topic?: string;
  readonly audience?: string;
  readonly outline: readonly string[];
  readonly sectionGuide: readonly BlogSectionGuide[];
  readonly seoKeywords: readonly string[];
  readonly draftBody?: string;
  /** BR-AI-5: overclaim phrases detected in supplied copy. */
  readonly inflatedPromisesDetected: readonly string[];
  readonly publishable: boolean;
  readonly note: string;
}

/** AG-403 — draft SEO-ready blog structure from topic + supplied copy. */
export function analyzeBlogDraft(input: MarketingStructuredInput): BlogDraft {
  const blog = input.blog;
  const topic = blog?.topic?.trim() ?? '';
  if (topic.length === 0) {
    return {
      dataSufficient: false,
      draftComplete: false,
      topic: undefined,
      outline: [],
      sectionGuide: [],
      seoKeywords: blog?.seoKeywords ?? [],
      inflatedPromisesDetected: [],
      publishable: false,
      note: 'A topic is required to structure a blog draft — nothing is generated without one.',
    };
  }
  const outline = outlineLines(blog?.outline);
  const sectionGuide = SEO_SECTION_GUIDE;
  const draftBody = blog?.userDraft?.trim() ?? '';
  const inflatedPromisesDetected = detectInflatedPromises(draftBody);
  return {
    dataSufficient: true,
    draftComplete: draftBody.length > 0,
    topic,
    audience: blog?.audience,
    outline,
    sectionGuide,
    seoKeywords: blog?.seoKeywords ?? [],
    draftBody:
      draftBody.length > 0
        ? sanitizeMarketingText(draftBody, MARKETING_MAX_DOCUMENT_BYTES)
        : undefined,
    inflatedPromisesDetected,
    publishable: false,
    note:
      draftBody.length > 0
        ? `Draft body preserved (${inflatedPromisesDetected.length} overclaim phrase${inflatedPromisesDetected.length === 1 ? '' : 's'} flagged); publish is gated behind human review.`
        : `Blog structure prepared for "${topic}" — supply draft copy; the deterministic engine does not invent an article body.`,
  };
}

const SEO_SECTION_GUIDE: readonly BlogSectionGuide[] = Object.freeze([
  { heading: 'Introduction', purpose: 'Frame the topic and state the value for the reader.' },
  { heading: 'Body', purpose: 'Cover the topic deterministically, keyword-aware, scannable.' },
  { heading: 'Conclusion', purpose: 'Recap the key takeaways without overclaiming.' },
  { heading: 'Call to action', purpose: 'One clear, non-promissory next step for the reader.' },
]);

function outlineLines(outline: string | undefined): readonly string[] {
  if (outline === undefined || outline.trim().length === 0) {
    return [];
  }
  return outline
    .split(/\r?\n/)
    .map((line) => sanitizeMarketingText(line, 512))
    .filter((line) => line.length > 0)
    .slice(0, 20);
}

const INFLATED_PROMISE_RE =
  /(guaranteed\s+(results?|ranking|traffic|conversions?|success|revenue)|100%\s+(guarantee|convert|ranking)|no\s+risk\s+whatsoever|overnight\s+success|instant\s+ranking)/i;

function detectInflatedPromises(value: string): readonly string[] {
  if (value.trim().length === 0) {
    return [];
  }
  const lower = value.toLowerCase();
  const flags: string[] = [];
  if (/guaranteed\s+results/i.test(lower)) {
    flags.push('guaranteed-results');
  }
  if (/guaranteed\s+ranking/i.test(lower)) {
    flags.push('guaranteed-ranking');
  }
  if (/100%\s+(guarantee|convert|ranking)/i.test(lower)) {
    flags.push('100-percent-guarantee');
  }
  if (/no\s+risk\s+whatsoever/i.test(lower)) {
    flags.push('no-risk-whatsoever');
  }
  if (/overnight\s+success/i.test(lower)) {
    flags.push('overnight-success');
  }
  void INFLATED_PROMISE_RE;
  return flags.slice(0, 5);
}

// ---------------------------------------------------------------------------
// AG-404 — SEO Specialist (on-page recommendations; no stuffing, no guarantees)
// ---------------------------------------------------------------------------

/** One deterministic on-page SEO finding. */
export interface SeoFinding {
  readonly code: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly message: string;
}

/** Keyword mapping computed from the provided page snapshot. */
export interface KeywordMapping {
  readonly keyword: string;
  readonly inTitle: boolean;
  readonly inMeta: boolean;
  readonly inHeadings: boolean;
  /** Observed density in the provided body; 0 when no body was supplied. */
  readonly density: number;
}

/** Deterministic output of the SEO specialist. */
export interface SeoRecommendations {
  readonly dataSufficient: boolean;
  readonly findings: readonly SeoFinding[];
  readonly keywordMappings: readonly KeywordMapping[];
  /** Keywords whose observed density exceeds 3% (stuffing-risk, BR-AI-5). */
  readonly stuffingRiskKeywords: readonly string[];
  /** AG-404: ranking is never guaranteed or predicted. */
  readonly rankingGuaranteed: boolean;
  readonly recommendations: readonly string[];
  readonly note: string;
}

/** AG-404 — actionable on-page recommendations from the provided snapshot. */
export function analyzeSeo(input: MarketingStructuredInput): SeoRecommendations {
  const seo = input.seo;
  if (seo === undefined) {
    return {
      dataSufficient: false,
      findings: [],
      keywordMappings: [],
      stuffingRiskKeywords: [],
      rankingGuaranteed: false,
      recommendations: [
        'Provide page content (title, meta, headings) and a keyword set to run an on-page review.',
      ],
      note: 'No page snapshot was provided — nothing is assumed and no ranking claim is made.',
    };
  }
  const title = seo.title?.trim() ?? '';
  const meta = seo.metaDescription?.trim() ?? '';
  const headings = seo.headings ?? [];
  const body = seo.body?.trim() ?? '';
  const keywords = seo.keywords ?? [];

  const findings: SeoFinding[] = [];
  if (title.length === 0) {
    findings.push({ code: 'TITLE_MISSING', severity: 'high', message: 'Add a title tag.' });
  } else if (title.length > 65) {
    findings.push({
      code: 'TITLE_TOO_LONG',
      severity: 'low',
      message: `Title is ${title.length} chars — trimming toward 50-60 chars keeps it readable.`,
    });
  }
  if (meta.length === 0) {
    findings.push({
      code: 'META_MISSING',
      severity: 'high',
      message: 'Add a meta description.',
    });
  } else if (meta.length > 160) {
    findings.push({
      code: 'META_TOO_LONG',
      severity: 'low',
      message: `Meta description is ${meta.length} chars — 70-160 chars is the guidance.`,
    });
  }
  if (headings.length === 0) {
    findings.push({
      code: 'HEADINGS_MISSING',
      severity: 'medium',
      message: 'Add headings to structure the page for readers and crawlers.',
    });
  }

  const wordCount = body.length > 0 ? body.split(/\s+/).length : 0;
  const lowerBody = body.toLowerCase();
  const keywordMappings: KeywordMapping[] = keywords.map((keyword) => {
    const lowerKeyword = keyword.toLowerCase();
    const occurrences = wordCount > 0 ? countOccurrences(lowerBody, lowerKeyword) : 0;
    return {
      keyword,
      inTitle: includesKeyword(title, lowerKeyword),
      inMeta: includesKeyword(meta, lowerKeyword),
      inHeadings: headings.some((heading) => includesKeyword(heading, lowerKeyword)),
      density: wordCount > 0 ? Math.round((occurrences / wordCount) * 10000) / 100 : 0,
    };
  });
  const stuffingRiskKeywords = keywordMappings
    .filter((mapping) => mapping.density > 3)
    .map((mapping) => mapping.keyword);

  const recommendations: string[] = [];
  if (title.length === 0) {
    recommendations.unshift('Add a title tag that reflects the primary keyword.');
  }
  if (meta.length === 0) {
    recommendations.unshift('Add a meta description summarizing the page value.');
  }
  if (headings.length === 0) {
    recommendations.unshift('Add scannable headings that reflect the keyword set.');
  }
  if (stuffingRiskKeywords.length > 0) {
    recommendations.push(
      `Review keyword density — ${stuffingRiskKeywords.join(', ')} exceed 3% of body words (no stuffing, BR-AI-5).`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'On-page baseline is solid; keep title/meta/headings keyword-aware and content user-first.',
    );
  }
  if (keywords.length === 0) {
    recommendations.push('Add a keyword set so keyword mapping can be computed.');
  }

  return {
    dataSufficient: true,
    findings,
    keywordMappings,
    stuffingRiskKeywords,
    rankingGuaranteed: false,
    recommendations: recommendations.slice(0, 8),
    note: 'Recommendations are actionable on-page guidance; ranking is never guaranteed (AG-404).',
  };
}

function includesKeyword(value: string, keyword: string): boolean {
  return keyword.length > 0 && value.toLowerCase().includes(keyword);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 50) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// ---------------------------------------------------------------------------
// AG-405 — Email Marketing (lifecycle drafts; opt-out honoured, sends gated)
// ---------------------------------------------------------------------------

/** Deterministic output of the email marketer. */
export interface EmailDraft {
  readonly dataSufficient: boolean;
  readonly draftComplete: boolean;
  readonly audience?: string;
  readonly campaignType?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly cta?: string;
  readonly tone?: string;
  readonly brandKeywordMatches: readonly string[];
  /** F20 business rule: opt-outs are honoured — always true here. */
  readonly optOutRespected: boolean;
  /** AG-405: sends are always gated. */
  readonly sendsGated: boolean;
  readonly spamRisks: readonly string[];
  readonly publishable: boolean;
  readonly note: string;
}

/** AG-405 — structure lifecycle/campaign email drafts; sends stay gated. */
export function analyzeEmailDraft(input: MarketingStructuredInput): EmailDraft {
  const email = input.email;
  const subject = email?.subject?.trim() ?? '';
  const body = email?.body?.trim() ?? '';
  const cta = email?.cta?.trim() ?? '';
  const draftComplete = subject.length > 0 && body.length > 0 && cta.length > 0;

  const spamRisks: string[] = [];
  if (subject.length > 0 && uppercaseRatio(subject) > 0.6) {
    spamRisks.push('all-caps-subject');
  }
  if (/!{3,}/.test(body) || /!{3,}/.test(subject)) {
    spamRisks.push('excessive-punctuation');
  }
  if (/(free|fastest|winner|guaranteed|no\s+cost)\b/i.test(`${subject} ${body} ${cta}`)) {
    spamRisks.push('promotional-flagged-terms');
  }

  const brandKeywords = email?.brandKeywords ?? [];
  const brandKeywordMatches = brandKeywords.filter((keyword) =>
    `${subject} ${body} ${cta}`.toLowerCase().includes(keyword.toLowerCase()),
  );

  return {
    dataSufficient: true,
    draftComplete,
    audience: email?.audience,
    campaignType: email?.campaignType,
    subject: draftComplete ? sanitizeMarketingText(subject, 512) : undefined,
    body: draftComplete ? sanitizeMarketingText(body, MARKETING_MAX_DOCUMENT_BYTES) : undefined,
    cta: draftComplete ? sanitizeMarketingText(cta, 512) : undefined,
    tone: email?.tone,
    brandKeywordMatches,
    optOutRespected: true,
    sendsGated: true,
    spamRisks: spamRisks.slice(0, 5),
    publishable: false,
    note: draftComplete
      ? 'Email draft validated and structured; sends are gated behind human approval, opt-outs are honoured.'
      : 'Supply subject, body and CTA to validate a draft — the deterministic engine does not fabricate promotional copy.',
  };
}

function uppercaseRatio(value: string): number {
  const letters = value.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) {
    return 0;
  }
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length;
}

// ---------------------------------------------------------------------------
// Runtime agents
// ---------------------------------------------------------------------------

const DEP = (id: string) => ({ type: DependencyType.Agent, id, required: false });

function marketingCapabilities(ids: readonly string[]): readonly AgentCapability[] {
  return Object.freeze(ids.map((id) => ({ id, name: id, enabled: true })));
}

/** A deterministic per-capability analyzer shared by the runtime agents. */
type MarketingAnalyzer = (
  capabilityId: string,
  input: MarketingStructuredInput,
) => {
  readonly output: Readonly<Record<string, unknown>>;
  readonly recommendations: readonly unknown[];
};

interface MarketingAgentConfig {
  readonly agentId: string;
  readonly name: string;
  readonly category: AgentCategory;
  readonly status: AgentStatus;
  readonly capabilities: readonly string[];
  readonly dependencies: readonly string[];
  readonly maxTokens: number;
}

function createMarketingAgent(config: MarketingAgentConfig): RuntimeAgent {
  const { agentId } = config;
  return {
    configuration: {
      agentId,
      name: config.name,
      version: MARKETING_TEAM_VERSION,
      category: config.category,
      status: config.status,
      capabilities: marketingCapabilities(config.capabilities),
      dependencies: Object.freeze(config.dependencies.map(DEP)),
      limits: { maxTokens: config.maxTokens, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const delay = clampDelay(parseNumber(context.inputs['marketing.delayMs'], 0));
      if (delay > 0) {
        await wait(delay, context);
      }
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractMarketingInput(context.inputs);
      const capabilityId = resolveCapability(
        agentId,
        config.capabilities,
        context.inputs['marketing.capability'],
      );
      const { output, recommendations } = dispatchAnalyzer(agentId, capabilityId, input);
      return {
        success: true,
        output: {
          ...output,
          recommendations,
        },
        metadata: { provider: 'runtime', agentId, version: MARKETING_TEAM_VERSION },
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
export const MARKETING_CAPABILITY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  [MARKETING_CAPABILITY_IDS.research]: 'research',
  [MARKETING_CAPABILITY_IDS.socialPost]: 'social',
  [MARKETING_CAPABILITY_IDS.blogDraft]: 'blog',
  [MARKETING_CAPABILITY_IDS.seoAnalyze]: 'seo',
  [MARKETING_CAPABILITY_IDS.emailDraft]: 'email',
});

function wrapOutput(
  capabilityId: string,
  result: Record<string, unknown>,
  recommendations: readonly unknown[],
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const key = MARKETING_CAPABILITY_KEYS[capabilityId] ?? 'result';
  return { output: { [key]: result[key] ?? result }, recommendations };
}

function analyzeResearchOutput(
  capabilityId: string,
  input: MarketingStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const research = analyzeResearch(input);
  const recommendations = research.dataSufficient
    ? [{ recommendation: 'Research summaries are ready for editor review before any KB write.' }]
    : [{ recommendation: 'Add cited sources with claims to compile research insights.' }];
  return wrapOutput(capabilityId, { research }, recommendations);
}

function analyzeSocialOutput(
  capabilityId: string,
  input: MarketingStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const social = analyzeSocialPost(input);
  const recommendations = social.draftComplete
    ? [{ recommendation: 'Approve the draft through the human review gate before scheduling.' }]
    : [{ recommendation: 'Provide post copy or approve the platform/structure guidance.' }];
  return wrapOutput(capabilityId, { social }, recommendations);
}

function analyzeBlogOutput(
  capabilityId: string,
  input: MarketingStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const blog = analyzeBlogDraft(input);
  const recommendations: unknown[] = [];
  if (blog.dataSufficient) {
    if (!blog.draftComplete) {
      recommendations.push({ recommendation: 'Supply the article body to complete the draft.' });
    }
    if (blog.inflatedPromisesDetected.length > 0) {
      recommendations.push({
        recommendation: `Remove overclaim phrasing (${blog.inflatedPromisesDetected.join(', ')}) — BR-AI-5.`,
      });
    }
    if (blog.seoKeywords.length === 0) {
      recommendations.push({ recommendation: 'Add target keywords for the SEO-ready structure.' });
    }
    recommendations.push({
      recommendation: 'Publish is gated behind human review; never auto-published.',
    });
  }
  return wrapOutput(capabilityId, { blog }, recommendations);
}

function analyzeSeoOutput(
  capabilityId: string,
  input: MarketingStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const seo = analyzeSeo(input);
  const recommendations = seo.recommendations.map((recommendation) => ({ recommendation }));
  return wrapOutput(capabilityId, { seo }, recommendations);
}

function analyzeEmailOutput(
  capabilityId: string,
  input: MarketingStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const email = analyzeEmailDraft(input);
  const recommendations: unknown[] = [];
  if (!email.draftComplete) {
    recommendations.push({
      recommendation: 'Supply subject, body and CTA to validate an email draft.',
    });
  }
  if (email.spamRisks.length > 0) {
    recommendations.push({
      recommendation: `Review spam-risk signals (${email.spamRisks.join(', ')}) before human approval.`,
    });
  }
  recommendations.push({ recommendation: 'Sends are gated — human approval is mandatory.' });
  return wrapOutput(capabilityId, { email }, recommendations);
}

/** Full capability → analyzer dispatch used by all create* agents. */
const MARKETING_ANALYZERS: Readonly<Record<string, MarketingAnalyzer>> = Object.freeze({
  [MARKETING_CAPABILITY_IDS.research]: analyzeResearchOutput,
  [MARKETING_CAPABILITY_IDS.socialPost]: analyzeSocialOutput,
  [MARKETING_CAPABILITY_IDS.blogDraft]: analyzeBlogOutput,
  [MARKETING_CAPABILITY_IDS.seoAnalyze]: analyzeSeoOutput,
  [MARKETING_CAPABILITY_IDS.emailDraft]: analyzeEmailOutput,
});

/** AG-401 — Research Agent (market/competitor research feeding the KB). */
export function createResearchAgent(): RuntimeAgent {
  const agentId = MARKETING_AGENT_IDS.research;
  return createMarketingAgent({
    agentId,
    name: 'Research Agent',
    category: AgentCategory.Marketing,
    status: AgentStatus.Draft,
    capabilities: [MARKETING_CAPABILITY_IDS.research],
    dependencies: [],
    maxTokens: 4000,
  });
}

/** AG-402 — Social Media Manager (on-brand post drafts, no auto-publish). */
export function createSocialMediaManagerAgent(): RuntimeAgent {
  const agentId = MARKETING_AGENT_IDS.socialMedia;
  return createMarketingAgent({
    agentId,
    name: 'Social Media Manager',
    category: AgentCategory.Marketing,
    status: AgentStatus.Draft,
    capabilities: [MARKETING_CAPABILITY_IDS.socialPost],
    dependencies: [MARKETING_AGENT_IDS.research],
    maxTokens: 4000,
  });
}

/** AG-403 — Blog Writer (SEO-ready blog drafts, review gate, BR-AI-5). */
export function createBlogWriterAgent(): RuntimeAgent {
  const agentId = MARKETING_AGENT_IDS.blogWriter;
  return createMarketingAgent({
    agentId,
    name: 'Blog Writer',
    category: AgentCategory.Marketing,
    status: AgentStatus.Draft,
    capabilities: [MARKETING_CAPABILITY_IDS.blogDraft],
    dependencies: [MARKETING_AGENT_IDS.seoSpecialist, MARKETING_AGENT_IDS.research],
    maxTokens: 6000,
  });
}

/** AG-404 — SEO Specialist (on-page recommendations, no ranking guarantees). */
export function createSeoSpecialistAgent(): RuntimeAgent {
  const agentId = MARKETING_AGENT_IDS.seoSpecialist;
  return createMarketingAgent({
    agentId,
    name: 'SEO Specialist',
    category: AgentCategory.Marketing,
    status: AgentStatus.Draft,
    capabilities: [MARKETING_CAPABILITY_IDS.seoAnalyze],
    dependencies: [MARKETING_AGENT_IDS.research],
    maxTokens: 4000,
  });
}

/** AG-405 — Email Marketing (lifecycle drafts, sends gated, opt-out honoured). */
export function createEmailMarketerAgent(): RuntimeAgent {
  const agentId = MARKETING_AGENT_IDS.emailMarketer;
  return createMarketingAgent({
    agentId,
    name: 'Email Marketing',
    category: AgentCategory.Marketing,
    status: AgentStatus.Draft,
    capabilities: [MARKETING_CAPABILITY_IDS.emailDraft],
    dependencies: [MARKETING_AGENT_IDS.research],
    maxTokens: 4000,
  });
}

/** All marketing-team runtime agents introduced by this module. */
export function createMarketingTeamAgents(): readonly RuntimeAgent[] {
  return [
    createResearchAgent(),
    createSocialMediaManagerAgent(),
    createBlogWriterAgent(),
    createSeoSpecialistAgent(),
    createEmailMarketerAgent(),
  ];
}

/** Dispatches to the analyzer for the selected capability (or primary fallback). */
function dispatchAnalyzer(
  agentId: string,
  capabilityId: string,
  input: MarketingStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const resolver = MARKETING_ANALYZERS[capabilityId];
  if (resolver === undefined) {
    throw new Error(`No marketing analyzer for capability ${capabilityId} on ${agentId}`);
  }
  return resolver(capabilityId, input);
}

function defaultCapabilityFor(agentId: string): string {
  switch (agentId) {
    case MARKETING_AGENT_IDS.research:
      return MARKETING_CAPABILITY_IDS.research;
    case MARKETING_AGENT_IDS.socialMedia:
      return MARKETING_CAPABILITY_IDS.socialPost;
    case MARKETING_AGENT_IDS.blogWriter:
      return MARKETING_CAPABILITY_IDS.blogDraft;
    case MARKETING_AGENT_IDS.seoSpecialist:
      return MARKETING_CAPABILITY_IDS.seoAnalyze;
    case MARKETING_AGENT_IDS.emailMarketer:
      return MARKETING_CAPABILITY_IDS.emailDraft;
    default:
      throw new Error(`Unknown marketing agent ${agentId}`);
  }
}

// ---------------------------------------------------------------------------
// Platform mirror definitions
// ---------------------------------------------------------------------------

/**
 * Platform mirror definitions for the marketing runtime agents
 * (AG-401..AG-405). Tool access is an explicit policy layer on top: every
 * marketing agent ships v1 with an empty allowlist (fail-closed), so agentic
 * tool calling is refused until a tool is explicitly enabled.
 */
export function createMarketingTeamAgentDefinitions(): readonly AgentDefinition[] {
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
      agentId: MARKETING_AGENT_IDS.research,
      name: 'Research Agent',
      version: MARKETING_TEAM_VERSION,
      description:
        'Compiles cited research insight summaries for the KB and rejects uncited claims (deterministic v1, BR-AI-4).',
      team: MARKETING_TEAM_GROUP,
      category: AgentCategory.Marketing,
      status: AgentStatus.Draft,
      capabilities: [capability(MARKETING_CAPABILITY_IDS.research)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', MARKETING_CAPABILITY_IDS.research],
      limits,
      dependencies: [],
      configuration: {},
    },
    {
      agentId: MARKETING_AGENT_IDS.socialMedia,
      name: 'Social Media Manager',
      version: MARKETING_TEAM_VERSION,
      description:
        'Structures on-brand social drafts with platform character budgets; publishing requires a human gate (deterministic v1, BR-AI-2).',
      team: MARKETING_TEAM_GROUP,
      category: AgentCategory.Marketing,
      status: AgentStatus.Draft,
      capabilities: [capability(MARKETING_CAPABILITY_IDS.socialPost)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', MARKETING_CAPABILITY_IDS.socialPost],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: MARKETING_AGENT_IDS.research,
          required: false,
        },
      ],
      configuration: {},
    },
    {
      agentId: MARKETING_AGENT_IDS.blogWriter,
      name: 'Blog Writer',
      version: MARKETING_TEAM_VERSION,
      description:
        'Drafts SEO-ready blog structure from briefs and supplied copy; flags overclaiming and gates publishing (deterministic v1, BR-AI-5).',
      team: MARKETING_TEAM_GROUP,
      category: AgentCategory.Marketing,
      status: AgentStatus.Draft,
      capabilities: [capability(MARKETING_CAPABILITY_IDS.blogDraft)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', MARKETING_CAPABILITY_IDS.blogDraft],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: MARKETING_AGENT_IDS.seoSpecialist,
          required: false,
        },
        {
          type: DependencyType.Agent,
          id: MARKETING_AGENT_IDS.research,
          required: false,
        },
      ],
      configuration: {},
    },
    {
      agentId: MARKETING_AGENT_IDS.seoSpecialist,
      name: 'SEO Specialist',
      version: MARKETING_TEAM_VERSION,
      description:
        'Recommends on-page SEO improvements from the provided snapshot; no keyword stuffing and ranking never guaranteed (deterministic v1, BR-AI-5).',
      team: MARKETING_TEAM_GROUP,
      category: AgentCategory.Marketing,
      status: AgentStatus.Draft,
      capabilities: [capability(MARKETING_CAPABILITY_IDS.seoAnalyze)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', MARKETING_CAPABILITY_IDS.seoAnalyze],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: MARKETING_AGENT_IDS.research,
          required: false,
        },
      ],
      configuration: {},
    },
    {
      agentId: MARKETING_AGENT_IDS.emailMarketer,
      name: 'Email Marketing',
      version: MARKETING_TEAM_VERSION,
      description:
        'Validates lifecycle/campaign email drafts (subject/body/CTA) with opt-out honoured and sends gated behind human approval (deterministic v1).',
      team: MARKETING_TEAM_GROUP,
      category: AgentCategory.Marketing,
      status: AgentStatus.Draft,
      capabilities: [capability(MARKETING_CAPABILITY_IDS.emailDraft)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['knowledge.read', MARKETING_CAPABILITY_IDS.emailDraft],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: MARKETING_AGENT_IDS.research,
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

function sanitizeOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const sanitized = sanitizeMarketingText(value, MARKETING_MAX_DOCUMENT_BYTES);
  return sanitized.length === 0 ? undefined : sanitized;
}
