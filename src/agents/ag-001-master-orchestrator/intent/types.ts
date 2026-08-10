import type { AgentId, IsoTimestamp, RequestId } from '../types/index.js';

/** Stable intent identifiers. Values follow the architecture dotted scheme
 * (orchestrator spec §5) so registry IDs stay compatible with routing tables. */
export enum IntentId {
  UNKNOWN = 'unknown',
  CREATE_PROJECT = 'project.create',
  UPDATE_PROJECT = 'project.edit',
  DELETE_PROJECT = 'project.delete',
  VIEW_PROJECT = 'project.view',
  SEARCH_PROJECTS = 'project.search',
  SUBMIT_PROPOSAL = 'proposal.submit',
  GENERATE_PROPOSAL = 'proposal.generate',
  OPTIMIZE_PROFILE = 'profile.optimize',
  BUILD_PORTFOLIO = 'portfolio.build',
  BUILD_RESUME = 'resume.build',
  GENERATE_COVER_LETTER = 'cover-letter.generate',
  MATCH_PROJECT = 'project.match',
  CAREER_ADVICE = 'career.advice',
  GENERATE_CONTRACT = 'contract.generate',
  PLAN_MILESTONES = 'milestone.plan',
  GENERATE_REVIEW = 'review.generate',
  REPORT_SCAM = 'scam.report',
  OPEN_DISPUTE = 'dispute.open',
  SEND_MESSAGE = 'message.send',
  SEARCH_KNOWLEDGE = 'knowledge.search',
  PLATFORM_HELP = 'platform.help',
  ADMIN_ACTION = 'admin.action',
  SYSTEM = 'system',
}

/** User roles recognised by the platform (PRD §3, BR-ADM-1). */
export enum UserRole {
  Guest = 'Guest',
  Client = 'Client',
  Freelancer = 'Freelancer',
  Admin = 'Admin',
  System = 'System',
}

/** Coarse grouping aligned with the keyword registry (prompt §5). */
export enum IntentCategory {
  Projects = 'Projects',
  Proposals = 'Proposals',
  Profiles = 'Profiles',
  Payments = 'Payments',
  Messages = 'Messages',
  Contracts = 'Contracts',
  Reviews = 'Reviews',
  Admin = 'Admin',
  Help = 'Help',
  Knowledge = 'Knowledge',
  System = 'System',
}

/** Relative importance of an intent when several match. */
export enum IntentPriority {
  Critical = 'Critical',
  High = 'High',
  Medium = 'Medium',
  Low = 'Low',
}

/** Lifecycle state of an intent in the registry. */
export enum IntentStatus {
  Active = 'Active',
  Deprecated = 'Deprecated',
  Draft = 'Draft',
  Inactive = 'Inactive',
}

/** A registered intent (orchestrator spec §5; prompt §1). */
export interface IntentDefinition {
  readonly id: IntentId;
  readonly name: string;
  readonly description: string;
  readonly category: IntentCategory;
  readonly priority: IntentPriority;
  readonly allowedRoles: readonly UserRole[];
  /** Per-intent minimum confidence before the intent is accepted. */
  readonly confidenceThreshold: number;
  readonly supportedAgents: readonly AgentId[];
  readonly status: IntentStatus;
}

/** A single keyword rule for an intent (prompt §4/§6). */
export interface IntentRule {
  readonly id: string;
  readonly intentId: IntentId;
  /** Keywords and phrases (lowercased) that trigger this intent. */
  readonly keywords: readonly string[];
  /** Weight of a full keyword match (phrases weigh more). */
  readonly keywordWeight: number;
}

/** Raw keyword match produced by the matcher (prompt §6). */
export interface IntentMatch {
  readonly ruleId: string;
  readonly intentId: IntentId;
  readonly matchedKeywords: readonly string[];
  /** Sum of matched keyword weights, used for deterministic scoring. */
  readonly matchedWeight: number;
}

/** A scored intent candidate (prompt §6). */
export interface IntentCandidate {
  readonly intent: IntentDefinition;
  readonly confidence: number;
  readonly matchedKeywords: readonly string[];
  readonly matchedRules: readonly string[];
}

/** Metadata attached to every classification result (prompt §6). */
export interface IntentMetadata {
  readonly classifier: string;
  readonly version: string;
  readonly detectedAt: IsoTimestamp;
  readonly inputLength: number;
  readonly elapsedMs: number;
  readonly thresholds: {
    readonly high: number;
    readonly low: number;
  };
}

/** Full classification result returned to the orchestrator (prompt §6/§7). */
export interface IntentResult {
  readonly primary: IntentCandidate;
  readonly secondary: readonly IntentCandidate[];
  readonly candidates: readonly IntentCandidate[];
  readonly confidence: number;
  readonly matchedKeywords: readonly string[];
  readonly matchedRules: readonly string[];
  readonly fallback: boolean;
  readonly fallbackReason?: string;
  readonly metadata: IntentMetadata;
}

/** Optional inputs a caller may supply to classification. */
export interface ClassifyOptions {
  readonly role?: UserRole;
  readonly requestId?: RequestId;
  readonly maxCandidates?: number;
}

/** Contract any intent classifier must satisfy (prompt §3). */
export interface IntentClassifier {
  readonly name: string;
  readonly version: string;
  classify(input: string, options?: ClassifyOptions): IntentResult;
}

/** Contract the keyword matcher must satisfy (prompt §3). */
export interface IntentMatcher {
  readonly name: string;
  match(input: string, rules: readonly IntentRule[]): readonly IntentMatch[];
}
