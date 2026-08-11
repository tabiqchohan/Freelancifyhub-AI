import type { IsoTimestamp, RequestId, TraceId } from '../../types/index.js';
import type { ContextBuildError } from '../errors/index.js';

/** Logical source of a context item. Future providers map 1:1 to these. */
export enum ContextSourceType {
  REQUEST = 'request',
  SESSION = 'session',
  USER = 'user',
  PROJECT = 'project',
  WORKSPACE = 'workspace',
  MEMORY = 'memory',
  KNOWLEDGE = 'knowledge',
  TOOL = 'tool',
  SYSTEM = 'system',
  AGENT = 'agent',
}

/** Deterministic priority used for ordering and budget trimming. */
export enum ContextPriority {
  CRITICAL = 'critical',
  HIGH = 'high',
  NORMAL = 'normal',
  LOW = 'low',
  OPTIONAL = 'optional',
}

/** Stable logical sections the assembled context is grouped into. */
export enum ContextSectionType {
  SYSTEM = 'system',
  REQUEST = 'request',
  USER = 'user',
  PROJECT = 'project',
  CONVERSATION = 'conversation',
  MEMORY = 'memory',
  KNOWLEDGE = 'knowledge',
  TOOL = 'tool',
  AGENT = 'agent',
}

/** Behaviour when the assembled context exceeds the budget. */
export type ContextOverflowBehavior = 'truncate' | 'fail';

/** Primitive-only metadata attached to a context item. */
export type ContextMetadata = Readonly<Record<string, string | number | boolean>>;

/** Identifies where a context item came from (no data is fetched in Sprint 3). */
export interface ContextSource {
  readonly type: ContextSourceType;
  readonly id?: string;
}

/** A single normalized, validated context item. */
export interface ContextItem {
  readonly id: string;
  readonly source: ContextSource;
  readonly section: ContextSectionType;
  readonly content: string;
  readonly priority: ContextPriority;
  readonly metadata?: ContextMetadata;
  /** Explicit ordering hint within the same priority. */
  readonly order?: number;
}

/** Accepted input shape; priority may be omitted and is assigned during build. */
export interface ContextItemInput {
  readonly id: string;
  readonly source: ContextSource;
  readonly section: ContextSectionType;
  readonly content: string;
  readonly priority?: ContextPriority;
  readonly metadata?: ContextMetadata;
  readonly order?: number;
}

/** A group of context items belonging to one logical section. */
export interface ContextSection {
  readonly section: ContextSectionType;
  readonly items: readonly ContextItem[];
  readonly estimatedTokens: number;
}

/** Token-budget controls applied during assembly. */
export interface ContextBudget {
  readonly maxTokens: number;
  readonly reservedTokens: number;
  readonly minTokens: number;
  readonly warningThreshold: number;
  readonly overflowBehavior: ContextOverflowBehavior;
  readonly perSection: Readonly<Partial<Record<ContextSectionType, number>>>;
}

/** A structured, non-fatal problem surfaced during a build. */
export interface ContextBuildWarning {
  readonly code: string;
  readonly message: string;
  readonly itemId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Deterministic statistics produced for every build. */
export interface ContextStatistics {
  readonly totalItems: number;
  readonly includedItems: number;
  readonly excludedItems: number;
  readonly itemsBySource: Readonly<Partial<Record<ContextSourceType, number>>>;
  readonly itemsByPriority: Readonly<Partial<Record<ContextPriority, number>>>;
  readonly itemsBySection: Readonly<Partial<Record<ContextSectionType, number>>>;
  readonly estimatedTokens: number;
  readonly budgetUtilization: number;
  readonly deduplicatedCount: number;
  readonly overflowCount: number;
  readonly warningsCount: number;
}

/** The immutable output of a context build. */
export interface ContextSnapshot {
  readonly version: string;
  readonly builtAt: IsoTimestamp;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly sections: readonly ContextSection[];
  readonly items: readonly ContextItem[];
  readonly estimatedTokens: number;
  readonly budget: ContextBudget;
  readonly warnings: readonly ContextBuildWarning[];
  readonly statistics: ContextStatistics;
}

/** Everything the builder needs to assemble a context. */
export interface ContextBuildRequest {
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly items: readonly ContextItemInput[];
  /** Optional overrides on top of the configured defaults. */
  readonly budget?: Partial<ContextBudget>;
}

/** The result of a context build: snapshot plus structured diagnostics. */
export interface ContextBuildResult {
  readonly snapshot: ContextSnapshot;
  readonly warnings: readonly ContextBuildWarning[];
  readonly errors: readonly ContextBuildError[];
  readonly statistics: ContextStatistics;
}
