import type { Logger } from 'pino';

import { systemClock, type Clock } from '../clock/index.js';
import type { MemoryConfig } from '../config/schema.js';
import { memoryConfig } from '../config/index.js';
import {
  MemoryLifecycleState,
  MemoryPermission,
  MemoryPriority,
  MemoryType,
} from '../enums/index.js';
import type { MemorySecurityLevel } from '../enums/index.js';
import { MemoryValidationError } from '../errors/index.js';
import type { RetrievalResult, TokenEstimator } from '../retrieval/index.js';
import { SimpleTokenEstimator } from '../retrieval/token-estimator.js';
import type { AuthorizationService, MemoryActor } from '../security/index.js';
import type { MemoryId, MemoryNamespace } from '../types/index.js';
import { isMemoryExpired } from '../retention/index.js';
import { createMemoryLogger } from '../utils/logger.js';

/**
 * Sprint 5A Context Integration contract + engine (prompt §1-§11).
 *
 * The Context Integration Engine transforms already-authorized retrieval
 * results into a deterministic, safe, prioritized context for later
 * orchestration-layer consumption. It is NOT an LLM summarizer and NOT a
 * vector search engine. It reuses the existing RetrievalResult contract, the
 * existing TokenEstimator, existing lifecycle filtering, existing
 * authorization/security infrastructure and the existing Zod configuration
 * architecture.
 */

/** A single deterministic, redacted context entry derived from a record. */
export interface ContextRecordEntry {
  readonly id: MemoryId;
  readonly namespace: MemoryNamespace;
  readonly key: string;
  readonly type: MemoryType;
  readonly priority: MemoryPriority;
  readonly securityLevel: MemorySecurityLevel;
  /** Redacted, bounded snippet. Never contains sensitive values. */
  readonly snippet: string;
  readonly tokenEstimate: number;
  readonly version: number;
}

/** A deterministic context section grouping records of one memory type. */
export interface ContextSection {
  readonly type: MemoryType;
  readonly priority: MemoryPriority;
  readonly records: readonly ContextRecordEntry[];
  readonly tokenEstimate: number;
  readonly truncated: boolean;
  readonly sourceInformation: {
    readonly candidateCount: number;
    readonly selectedCount: number;
  };
}

/** Deterministic statistics produced by the Context Integration Engine. */
export interface ContextIntegrationStatistics {
  readonly inputCount: number;
  readonly authorizedCount: number;
  readonly filteredCount: number;
  readonly duplicateCount: number;
  readonly selectedCount: number;
  readonly truncatedCount: number;
  readonly excludedCount: number;
  readonly estimatedTokens: number;
  readonly budget: number;
  readonly sectionsGenerated: number;
  readonly processingDurationMs: number;
}

/** Deterministic metadata for a context integration run. */
export interface ContextIntegrationMetadata {
  readonly traceId: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

/** The deterministic response produced by the Context Integration Engine. */
export interface ContextIntegrationResponse {
  readonly sections: readonly ContextSection[];
  readonly statistics: ContextIntegrationStatistics;
  readonly metadata: ContextIntegrationMetadata;
  /** True when snippets were redacted at the trust boundary. */
  readonly sanitized: boolean;
  /** False when the context integration feature is disabled. */
  readonly enabled: boolean;
}

/** A requested context section (maps 1:1 to a memory type). */
export interface ContextSectionRequest {
  readonly type: MemoryType;
}

/** A request to assemble a deterministic context from retrieval results. */
export interface ContextIntegrationRequest {
  readonly actor: MemoryActor;
  /** Already-authorized retrieval results (reused RetrievalResult contract). */
  readonly results: readonly RetrievalResult[];
  /** Optional explicit section selection. Defaults to all observed types. */
  readonly sections?: readonly ContextSectionRequest[];
  /** Optional budget override. Falls back to configuration. */
  readonly contextBudgetTokens?: number;
  /** Optional per-section record cap override. */
  readonly maxRecordsPerSection?: number;
  /** Optional snippet length override. */
  readonly snippetLength?: number;
  readonly traceId?: string;
}

/** Pipeline limits used for overrides (mirrors the retrieval contract). */
export interface ContextIntegrationPipelineConfig {
  readonly maxSections: number;
  readonly maxRecordsPerSection: number;
  readonly contextBudgetTokens: number;
  readonly snippetLength: number;
}

/** Options for constructing the Context Integration Service. */
export interface ContextIntegrationServiceOptions {
  readonly authorizationService: AuthorizationService;
  readonly config?: MemoryConfig;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly tokenEstimator?: TokenEstimator;
  readonly pipelineConfig?: Partial<ContextIntegrationPipelineConfig>;
}

/** Deterministic section precedence by memory type (prompt §3 precedence list). */
const SECTION_PRIORITY: Readonly<Record<MemoryType, number>> = {
  [MemoryType.ShortTerm]: 3,
  [MemoryType.Conversation]: 4,
  [MemoryType.User]: 8,
  [MemoryType.Project]: 7,
  [MemoryType.Workspace]: 6,
  [MemoryType.Organization]: 5,
  [MemoryType.KnowledgeReference]: 2,
  [MemoryType.Temporary]: 1,
  [MemoryType.Session]: 3,
  [MemoryType.LongTerm]: 9,
  [MemoryType.Archived]: 10,
};

/** Deterministic priority ordering (higher = more important, prompt §4). */
const PRIORITY_RANK: Readonly<Record<MemoryPriority, number>> = {
  [MemoryPriority.Critical]: 4,
  [MemoryPriority.High]: 3,
  [MemoryPriority.Medium]: 2,
  [MemoryPriority.Low]: 1,
};

/** Sensitive field names redacted at the context trust boundary (prompt §7). */
const SECRET_KEY_PATTERN =
  /(["']?)(?:api[\s_-]?key|password|passwd|passphrase|token|secret|credential|authorization|bearer|private[\s_-]?key|client[\s_-]?secret|pwd)\1\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|[^\s,}]+)/gi;

/** Plain secret-like values that should never survive into context (prompt §13). */
const SECRET_VALUE_PATTERN = /\b(sk-[a-zA-Z0-9_-]{16,}|[a-z0-9_-]{24,})\b/gi;

/**
 * Sprint 5A Context Integration Service (prompt §1-§11).
 *
 * Deterministic, side-effect-free context assembly. Accepts authorized
 * retrieval results and returns a deterministic ContextIntegrationResponse.
 */
export class ContextIntegrationServiceImpl {
  readonly name = 'memory-context-integration-service';
  readonly version = '1.0.0';

  private readonly config: MemoryConfig;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly authorizationService: AuthorizationService;
  private readonly tokenEstimator: TokenEstimator;
  private readonly pipelineConfig: ContextIntegrationPipelineConfig;

  constructor(options: ContextIntegrationServiceOptions) {
    this.config = options.config ?? memoryConfig;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? createMemoryLogger('context-integration-service');
    this.authorizationService = options.authorizationService;
    this.tokenEstimator = options.tokenEstimator ?? new SimpleTokenEstimator();
    this.pipelineConfig = {
      maxSections: this.config.MEMORY_CONTEXT_MAX_SECTIONS,
      maxRecordsPerSection: this.config.MEMORY_CONTEXT_MAX_RECORDS_PER_SECTION,
      contextBudgetTokens: this.config.MEMORY_CONTEXT_MAX_TOKENS,
      snippetLength: this.config.MEMORY_CONTEXT_SNIPPET_LENGTH,
      ...options.pipelineConfig,
    };
  }

  /** Assemble a deterministic context from authorized retrieval results. */
  async integrate(request: ContextIntegrationRequest): Promise<ContextIntegrationResponse> {
    this.assertValidRequest(request);

    const startTime = this.clock.getNow().getTime();
    const traceId = request.traceId ?? this.generateTraceId();

    if (!this.config.MEMORY_CONTEXT_INTEGRATION_ENABLED) {
      return this.disabledResponse(traceId, startTime);
    }

    const records = request.results;

    // 1. Lifecycle filtering (reuse Sprint 2 primitives)
    const live = records.filter(
      (r) =>
        r.record.lifecycle !== MemoryLifecycleState.Deleted &&
        r.record.lifecycle !== MemoryLifecycleState.Expired &&
        !isMemoryExpired(r.record),
    );
    const lifecycleExcluded = records.length - live.length;

    // 2. Authorization / scope filtering at the trust boundary (fail-closed)
    const authorized: { record: RetrievalResult['record']; score: number }[] = [];
    for (const result of live) {
      const decision = this.authorizationService.authorize({
        actor: request.actor,
        permission: MemoryPermission.Read,
        target: {
          namespace: result.record.namespace,
          type: result.record.type,
          securityLevel: result.record.securityLevel,
          lifecycle: result.record.lifecycle,
          owner: result.record.owner,
        },
      });
      if (decision.allowed) {
        authorized.push({ record: result.record, score: result.score });
      }
    }
    const excludedCount = records.length - authorized.length;

    // 3. Group into sections by memory type (section request filter applied here)
    const requestedTypes = request.sections
      ? new Set(request.sections.map((s) => s.type))
      : new Set<MemoryType>();
    const grouped = this.groupIntoSections(authorized, requestedTypes);

    // 4. Deduplicate within each section by namespace:key (prompt §6)
    for (const section of grouped.values()) {
      this.deduplicate(section.entries);
    }
    const duplicateCount =
      records.length - Array.from(grouped.values()).reduce((sum, s) => sum + s.entries.length, 0);

    // 5. Order records within each section deterministically (prompt §3, §4)
    for (const section of grouped.values()) {
      section.entries.sort((a, b) => this.compareRecords(a, b));
    }

    // 6. Apply per-section record cap and global budget with priority preservation
    const perSectionCap = this.effectivePerSectionCap(request);
    const budget = this.effectiveBudget(request);
    const budgeted = this.applyBudget(grouped, perSectionCap, budget);

    // 7. Order sections by section priority, capped by maxSections
    const maxSections = this.pipelineConfig.maxSections;
    const orderedSections = this.orderSections(budgeted.sections);

    // 8. Assemble safe, redacted, immutable entries
    const snippetLength = this.snippetLength(request);
    let sanitized = false;
    const sections: ContextSection[] = [];
    for (const section of orderedSections.slice(0, maxSections)) {
      const recordsInSection = section.entries.map((e) => {
        const snippetResult = this.buildSafeSnippet(e.record, snippetLength);
        if (snippetResult.redacted) sanitized = true;
        return snippetResult.entry;
      });
      sections.push({
        type: section.type,
        priority: this.sectionPriority(section.entries),
        records: recordsInSection,
        tokenEstimate: recordsInSection.reduce((sum, e) => sum + e.tokenEstimate, 0),
        truncated: section.truncated,
        sourceInformation: {
          candidateCount: section.candidateCount,
          selectedCount: recordsInSection.length,
        },
      });
    }

    const endTime = this.clock.getNow().getTime();

    const selectedCount = sections.reduce((sum, s) => sum + s.records.length, 0);
    const response: ContextIntegrationResponse = {
      sections,
      statistics: {
        inputCount: records.length,
        authorizedCount: authorized.length,
        filteredCount: lifecycleExcluded,
        duplicateCount,
        selectedCount,
        truncatedCount: budgeted.truncatedCount,
        excludedCount,
        estimatedTokens: sections.reduce((sum, s) => sum + s.tokenEstimate, 0),
        budget,
        sectionsGenerated: sections.length,
        processingDurationMs: endTime - startTime,
      },
      metadata: {
        traceId,
        durationMs: endTime - startTime,
        truncated: budgeted.truncatedCount > 0,
      },
      sanitized,
      enabled: true,
    };

    this.logger.info(
      {
        traceId,
        inputCount: records.length,
        sectionsGenerated: sections.length,
        selectedCount,
        truncated: budgeted.truncatedCount > 0,
        durationMs: endTime - startTime,
      },
      'context integration completed',
    );

    return response;
  }

  private assertValidRequest(request: ContextIntegrationRequest): void {
    if (!request.actor || !request.actor.group) {
      throw new MemoryValidationError('Context integration requires a valid actor context', {
        code: 'INVALID_ACTOR_CONTEXT',
      });
    }
    if (!Array.isArray(request.results)) {
      throw new MemoryValidationError('Context integration requires a retrieval results array', {
        code: 'INVALID_RETRIEVAL_RESULT',
      });
    }
    if (request.contextBudgetTokens !== undefined && request.contextBudgetTokens < 0) {
      throw new MemoryValidationError('Context budget cannot be negative', {
        code: 'INVALID_BUDGET',
        details: { contextBudgetTokens: request.contextBudgetTokens },
      });
    }
    if (request.snippetLength !== undefined && request.snippetLength < 1) {
      throw new MemoryValidationError('Snippet length must be a positive integer', {
        code: 'INVALID_CONFIGURATION',
        details: { snippetLength: request.snippetLength },
      });
    }
  }

  private disabledResponse(traceId: string, startTime: number): ContextIntegrationResponse {
    const endTime = this.clock.getNow().getTime();
    return {
      sections: [],
      statistics: {
        inputCount: 0,
        authorizedCount: 0,
        filteredCount: 0,
        duplicateCount: 0,
        selectedCount: 0,
        truncatedCount: 0,
        excludedCount: 0,
        estimatedTokens: 0,
        budget: this.pipelineConfig.contextBudgetTokens,
        sectionsGenerated: 0,
        processingDurationMs: endTime - startTime,
      },
      metadata: { traceId, durationMs: endTime - startTime, truncated: false },
      sanitized: false,
      enabled: false,
    };
  }

  private groupIntoSections(
    items: { record: RetrievalResult['record']; score: number }[],
    requestedTypes: ReadonlySet<MemoryType>,
  ): Map<
    MemoryType,
    {
      type: MemoryType;
      entries: { record: RetrievalResult['record']; score: number }[];
      candidateCount: number;
      truncated: boolean;
    }
  > {
    const grouped = new Map<
      MemoryType,
      {
        type: MemoryType;
        entries: { record: RetrievalResult['record']; score: number }[];
        candidateCount: number;
        truncated: boolean;
      }
    >();
    for (const item of items) {
      if (requestedTypes.size > 0 && !requestedTypes.has(item.record.type)) continue;
      let section = grouped.get(item.record.type);
      if (!section) {
        section = { type: item.record.type, entries: [], candidateCount: 0, truncated: false };
        grouped.set(item.record.type, section);
      }
      section.entries.push(item);
    }
    for (const section of grouped.values()) {
      section.candidateCount = section.entries.length;
    }
    return grouped;
  }

  private deduplicate(entries: { record: RetrievalResult['record']; score: number }[]): void {
    const seen = new Map<string, { record: RetrievalResult['record']; score: number }>();
    for (const item of entries) {
      const key = `${item.record.namespace}:${item.record.key}`;
      const existing = seen.get(key);
      if (!existing || this.isBetterDuplicate(item, existing)) {
        seen.set(key, item);
      }
    }
    entries.length = 0;
    entries.push(...seen.values());
  }

  private isBetterDuplicate(
    candidate: { record: RetrievalResult['record']; score: number },
    current: { record: RetrievalResult['record']; score: number },
  ): boolean {
    const candPri = PRIORITY_RANK[candidate.record.priority] ?? 0;
    const currPri = PRIORITY_RANK[current.record.priority] ?? 0;
    if (candPri !== currPri) return candPri > currPri;
    if (candidate.score !== current.score) return candidate.score > current.score;
    return candidate.record.version > current.record.version;
  }

  private compareRecords(
    a: { record: RetrievalResult['record']; score: number },
    b: { record: RetrievalResult['record']; score: number },
  ): number {
    const priDiff =
      (PRIORITY_RANK[b.record.priority] ?? 0) - (PRIORITY_RANK[a.record.priority] ?? 0);
    if (priDiff !== 0) return priDiff;
    if (b.score !== a.score) return b.score - a.score;
    const versionDiff = b.record.version - a.record.version;
    if (versionDiff !== 0) return versionDiff;
    return `${a.record.namespace}:${a.record.key}`.localeCompare(
      `${b.record.namespace}:${b.record.key}`,
    );
  }

  private sectionPriority(
    entries: { record: RetrievalResult['record']; score: number }[],
  ): MemoryPriority {
    let highest: MemoryPriority = MemoryPriority.Low;
    for (const e of entries) {
      if (PRIORITY_RANK[e.record.priority] > PRIORITY_RANK[highest]) {
        highest = e.record.priority;
      }
    }
    return highest;
  }

  private orderSections(
    sections: {
      type: MemoryType;
      entries: { record: RetrievalResult['record']; score: number }[];
      candidateCount: number;
      truncated: boolean;
    }[],
  ): {
    type: MemoryType;
    entries: { record: RetrievalResult['record']; score: number }[];
    candidateCount: number;
    truncated: boolean;
  }[] {
    return [...sections].sort(
      (a, b) =>
        (SECTION_PRIORITY[b.type] ?? 0) - (SECTION_PRIORITY[a.type] ?? 0) ||
        a.type.localeCompare(b.type),
    );
  }

  private applyBudget(
    grouped: Map<
      MemoryType,
      {
        type: MemoryType;
        entries: { record: RetrievalResult['record']; score: number }[];
        candidateCount: number;
        truncated: boolean;
      }
    >,
    perSectionCap: number,
    budget: number,
  ): {
    sections: {
      type: MemoryType;
      entries: { record: RetrievalResult['record']; score: number }[];
      candidateCount: number;
      truncated: boolean;
    }[];
    truncatedCount: number;
  } {
    // First apply the per-section cap independently (deterministic).
    const cappedSections: {
      type: MemoryType;
      entries: { record: RetrievalResult['record']; score: number }[];
      candidateCount: number;
      truncated: boolean;
    }[] = [];
    let truncatedCount = 0;
    for (const section of grouped.values()) {
      let capTruncated = false;
      let entries = section.entries;
      if (section.entries.length > perSectionCap) {
        entries = section.entries.slice(0, perSectionCap);
        truncatedCount += section.entries.length - perSectionCap;
        capTruncated = true;
      }
      cappedSections.push({
        type: section.type,
        entries,
        candidateCount: section.candidateCount,
        truncated: capTruncated,
      });
    }

    // Second, enforce the global token budget with priority preservation.
    // Order sections/results by importance so CRITICAL is preserved first.
    const orderedSections = this.orderSections(cappedSections);
    let totalTokens = 0;
    let budgetTruncated = 0;
    const resultSections: {
      type: MemoryType;
      entries: { record: RetrievalResult['record']; score: number }[];
      candidateCount: number;
      truncated: boolean;
    }[] = [];

    for (const section of orderedSections) {
      const kept: { record: RetrievalResult['record']; score: number }[] = [];
      let sectionTruncated = section.truncated;
      for (const entry of section.entries) {
        const tokens = this.tokenEstimator.estimate(entry.record);
        if (totalTokens + tokens > budget) {
          budgetTruncated += 1;
          sectionTruncated = true;
          continue;
        }
        totalTokens += tokens;
        kept.push(entry);
      }
      resultSections.push({
        type: section.type,
        entries: kept,
        candidateCount: section.candidateCount,
        truncated: sectionTruncated || kept.length < section.entries.length,
      });
    }

    return { sections: resultSections, truncatedCount: truncatedCount + budgetTruncated };
  }

  private buildSafeSnippet(
    record: RetrievalResult['record'],
    maxLength: number,
  ): { entry: ContextRecordEntry; redacted: boolean } {
    const rawText = this.contentToText(record.content);
    const metadataText = this.metadataToText(record.metadata);
    const combined = rawText ? `${rawText} ${metadataText}`.trim() : metadataText;
    const { text, redacted } = this.redactSecrets(combined);
    const bounded = this.bound(text, maxLength);
    return {
      entry: {
        id: record.id,
        namespace: record.namespace,
        key: record.key,
        type: record.type,
        priority: record.priority,
        securityLevel: record.securityLevel,
        snippet: bounded,
        tokenEstimate: this.tokenEstimator.estimate(record),
        version: record.version,
      },
      redacted,
    };
  }

  private contentToText(content: RetrievalResult['record']['content']): string {
    if (content === undefined || content === null) return '';
    if (typeof content === 'string') return content;
    return JSON.stringify(content);
  }

  private metadataToText(metadata: RetrievalResult['record']['metadata']): string {
    if (!metadata) return '';
    try {
      return JSON.stringify(metadata as Readonly<Record<string, unknown>>);
    } catch {
      return '';
    }
  }

  private redactSecrets(text: string): { text: string; redacted: boolean } {
    let value = text;
    let redacted = false;
    const keyRedacted = value.replace(SECRET_KEY_PATTERN, '"[REDACTED]"');
    if (keyRedacted !== value) redacted = true;
    value = keyRedacted;
    const valueRedacted = value.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
    if (valueRedacted !== value) redacted = true;
    return { text: valueRedacted, redacted };
  }

  private bound(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, Math.max(0, maxLength - 3)) + '...';
  }

  private effectiveBudget(request: ContextIntegrationRequest): number {
    return request.contextBudgetTokens ?? this.pipelineConfig.contextBudgetTokens;
  }

  private effectivePerSectionCap(request: ContextIntegrationRequest): number {
    return request.maxRecordsPerSection ?? this.pipelineConfig.maxRecordsPerSection;
  }

  private snippetLength(request: ContextIntegrationRequest): number {
    return request.snippetLength ?? this.pipelineConfig.snippetLength;
  }

  private generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }
}

/** Context integration service contract (prompt §1). */
export interface ContextIntegrationService {
  readonly name: string;
  readonly version: string;
  integrate(request: ContextIntegrationRequest): Promise<ContextIntegrationResponse>;
}

/** Creates a {@link ContextIntegrationService} with injected dependencies. */
export function createContextIntegrationService(
  options: ContextIntegrationServiceOptions,
): ContextIntegrationService {
  const impl = new ContextIntegrationServiceImpl(options);
  return {
    name: impl.name,
    version: impl.version,
    integrate: (request) => impl.integrate(request),
  };
}
