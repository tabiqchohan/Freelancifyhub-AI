import type { Logger } from 'pino';

import { systemClock, type Clock } from '../clock/index.js';
import type { MemoryConfig } from '../config/schema.js';
import { memoryConfig } from '../config/index.js';
import type { MemoryRepository } from '../repositories/index.js';
import type { AuthorizationService, MemoryActor } from '../security/index.js';
import { MemoryPermission } from '../enums/index.js';
import type {
  RetrievalService,
  RetrievalRequest,
  RetrievalResponse,
  RetrievalServiceOptions,
} from '../retrieval/index.js';
import type { MemoryRecord } from '../types/index.js';

import { RepositoryCandidateRetriever } from '../retrieval/candidate-retriever.js';
import { DefaultScorer } from '../retrieval/scorer.js';
import { SimpleTokenEstimator } from '../retrieval/token-estimator.js';
import { createMemoryLogger } from '../utils/logger.js';

/**
 * Retrieval Service (Sprint 4).
 *
 * Orchestrates the full retrieval pipeline using existing primitives:
 * - Candidate retrieval via RepositoryCandidateRetriever
 * - Lifecycle filtering (Sprint 2)
 * - Authorization filtering (Sprint 3)
 * - Scope filtering
 * - Security-level filtering
 * - Relevance scoring via DefaultScorer (Sprint 4, prompt §11)
 * - Prioritization
 * - Deduplication
 * - Result limits
 * - Context budgeting via SimpleTokenEstimator (Sprint 4, prompt §17)
 * - Context assembly with safe snippets
 */
export class RetrievalServiceImpl implements RetrievalService {
  readonly name = 'memory-retrieval-service';
  readonly version = '1.0.0';

  private readonly config: MemoryConfig;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly repository: MemoryRepository;
  private readonly authorizationService: AuthorizationService;

  constructor(options: RetrievalServiceOptions) {
    this.config = options.config ?? memoryConfig;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? createMemoryLogger('retrieval-service');
    this.repository = options.repository;
    this.authorizationService = options.authorizationService;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResponse> {
    const startTime = this.clock.getNow().getTime();

    this.logger.info(
      { namespace: request.namespace, actorGroup: request.actor.group },
      'Retrieval request started',
    );

    if (!request.namespace) {
      throw new Error('Namespace is required for retrieval');
    }

    // Step 1: Candidate retrieval via RepositoryCandidateRetriever
    const candidateRetriever = new RepositoryCandidateRetriever(this.repository);
    const candidates = await candidateRetriever.retrieve(
      {
        namespace: request.namespace,
        query: request.query,
        filters: request.filters,
        limit: request.maxResults,
      },
      request.actor.namespaces ?? [],
    );

    this.logger.info({ candidateCount: candidates.length }, 'Candidates retrieved');

    // Step 2: Lifecycle filtering - exclude DELETED/EXPIRED
    const { MemoryLifecycleState } = await import('../enums/index.js');
    const { isMemoryExpired } = await import('../retention/index.js');

    const lifecycleFiltered = candidates.filter(
      (record) => record.lifecycle !== MemoryLifecycleState.Deleted && !isMemoryExpired(record),
    );

    this.logger.info(
      { lifecycleFilteredCount: lifecycleFiltered.length },
      'After lifecycle filter',
    );

    // Step 3: Authorization filtering (Sprint 3) - per-candidate, silent exclusion
    const actorNs = [...(request.actor.namespaces ?? [])];
    const authorized = await this.authorizeCandidates(lifecycleFiltered, request.actor);

    this.logger.info({ authorizedCount: authorized.length }, 'After authorization filter');

    // Step 4: Scope filtering
    const scopeFiltered = this.filterByScope(authorized, [...actorNs]);

    this.logger.info({ scopeFilteredCount: scopeFiltered.length }, 'After scope filter');

    // Step 5: Security-level filtering (fail-closed)
    const securityFiltered = this.filterBySecurityLevel(scopeFiltered, request.actor);

    this.logger.info({ securityFilteredCount: securityFiltered.length }, 'After security filter');

    // Step 5.5: Query normalization
    const normalizedQuery = this.normalizeQuery(request.query);

    // Step 5.5: Relevance scoring via DefaultScorer
    const scorer = new DefaultScorer(this.clock, {
      exactMatch: 0.3,
      tokenMatch: 0.25,
      phraseMatch: 0.15,
      typeWeight: 0.1,
      recencyWeight: 0.1,
      priorityWeight: 0.05,
      scopeWeight: 0.05,
    });

    const scored = authorized.map((record) => ({
      record,
      score: scorer.score(record, normalizedQuery ?? '', this.clock.getNow()),
    }));

    this.logger.info({ scoredCount: scored.length }, 'After scoring');

    // Step 6: Minimum score filtering
    const minScore = request.minScore ?? 0;
    const scoredMin = scored.filter((item) => item.score >= minScore);

    this.logger.info({ scoredMinCount: scoredMin.length }, 'After minScore filter');

    // Step 7: Prioritization (sort by score desc, then priority)
    const prioritized = this.prioritize(scoredMin);

    this.logger.info({ prioritizedCount: prioritized.length }, 'After prioritization');

    // Step 8: Deduplication (by namespace:key)
    const deduplicated = this.deduplicate(prioritized);

    this.logger.info({ deduplicatedCount: deduplicated.length }, 'After deduplication');

    // Step 9: Result limit
    const effectiveLimit = request.maxResults ?? this.config.MEMORY_RETRIEVAL_MAX_RESULTS ?? 50;
    const limited = this.applyLimit(deduplicated, effectiveLimit);

    this.logger.info({ limitedCount: limited.length }, 'After limit filter');

    // Step 10: Context budgeting via SimpleTokenEstimator
    const tokenEstimator = new SimpleTokenEstimator();
    const budgeted = this.applyContextBudget(limited, tokenEstimator);

    this.logger.info(
      { budgetedCount: budgeted.results.length, truncated: budgeted.truncated },
      'After context budget',
    );

    // Step 11: Context assembly with snippets
    const results = this.assembleResults(budgeted.results);

    const endTime = this.clock.getNow().getTime();

    const response: RetrievalResponse = {
      results,
      statistics: {
        candidateCount: candidates.length,
        authorizedCount: authorized.length,
        selectedCount: results.length,
        filteredCount: candidates.length - authorized.length,
        truncatedCount: budgeted.truncated ? 1 : 0,
      },
      metadata: {
        traceId: request.traceId ?? this.generateTraceId(),
        durationMs: endTime - startTime,
        truncated: budgeted.truncated,
      },
    };

    this.logger.info(
      { results: results.length, durationMs: endTime - startTime, truncated: budgeted.truncated },
      'Retrieval request completed',
    );

    return response;
  }

  private async authorizeCandidates(
    candidates: MemoryRecord[],
    actor: MemoryActor,
  ): Promise<MemoryRecord[]> {
    const authorized: MemoryRecord[] = [];

    for (const record of candidates) {
      const decision = this.authorizationService.authorize({
        actor,
        permission: MemoryPermission.Read,
        target: {
          namespace: record.namespace,
          type: record.type,
          securityLevel: record.securityLevel,
          lifecycle: record.lifecycle,
          owner: record.owner,
        },
      });

      if (decision.allowed) {
        authorized.push(record);
      }
    }

    return authorized;
  }

  private filterByScope(candidates: MemoryRecord[], actorNamespaces: string[]): MemoryRecord[] {
    if (actorNamespaces.length === 0) return [];

    return candidates.filter((record) => actorNamespaces.includes(record.namespace));
  }

  private filterBySecurityLevel(candidates: MemoryRecord[], actor: MemoryActor): MemoryRecord[] {
    const clearance = actor.securityClearance ?? 'INTERNAL';

    const clearanceOrder: Record<string, number> = {
      INTERNAL: 0,
      CONFIDENTIAL: 1,
    };

    const actorLevel = clearanceOrder[clearance] ?? 0;

    return candidates.filter((record) => {
      const targetLevel = clearanceOrder[record.securityLevel as 'INTERNAL' | 'CONFIDENTIAL'] ?? 0;
      return actorLevel >= targetLevel;
    });
  }

  private prioritize(items: { record: MemoryRecord; score: number }[]): {
    record: MemoryRecord;
    score: number;
  }[] {
    return [...items].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const priorityOrder: Record<string, number> = {
        CRITICAL: 4,
        HIGH: 3,
        MEDIUM: 2,
        LOW: 1,
      };
      return (priorityOrder[b.record.priority] ?? 0) - (priorityOrder[a.record.priority] ?? 0);
    });
  }

  private deduplicate(items: { record: MemoryRecord; score: number }[]): {
    record: MemoryRecord;
    score: number;
  }[] {
    const seen = new Map<string, { record: MemoryRecord; score: number }>();
    for (const item of items) {
      const key = `${item.record.namespace}:${item.record.key}`;
      const existing = seen.get(key);
      if (!existing || item.score > existing.score) {
        seen.set(key, item);
      }
    }
    return [...seen.values()];
  }

  private applyLimit(
    items: { record: MemoryRecord; score: number }[],
    limit: number,
  ): { record: MemoryRecord; score: number }[] {
    if (limit <= 0) return [];
    if (limit >= items.length) return [...items].sort((a, b) => b.score - a.score);
    return [...items].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private applyContextBudget(
    items: { record: MemoryRecord; score: number }[],
    tokenEstimator: SimpleTokenEstimator,
  ): {
    results: { record: MemoryRecord; score: number }[];
    truncated: boolean;
    truncatedCount: number;
  } {
    let totalTokens = 0;
    const results: { record: MemoryRecord; score: number }[] = [];
    let truncated = false;
    let truncatedCount = 0;

    for (const item of items) {
      const tokens = tokenEstimator.estimate(item.record);
      if (totalTokens + tokens > 8192) {
        truncated = true;
        truncatedCount = items.length - results.length;
        break;
      }
      totalTokens += tokens;
      results.push(item);
    }

    return { results, truncated, truncatedCount };
  }

  private assembleResults(items: { record: MemoryRecord; score: number }[]): {
    record: MemoryRecord;
    score: number;
    snippet?: string;
  }[] {
    return items.map((item) => ({
      record: item.record,
      score: item.score,
      snippet: this.generateSnippet(item.record),
    }));
  }

  private generateSnippet(record: MemoryRecord): string | undefined {
    let text: string;
    if (typeof record.content === 'string') {
      text = record.content;
    } else if (typeof record.content === 'object' && record.content !== null) {
      text = JSON.stringify(record.content);
    } else {
      return undefined;
    }

    // Redact secrets
    text = text
      .replace(/apiKey\s*:\s*sk[-\w]{20,}/g, '[REDACTED]')
      .replace(/password\s*:\s*\S+/gi, '[REDACTED]')
      .replace(/\btoken\s*:\s*\S+/gi, '[REDACTED]');

    return text.length > 200 ? text.substring(0, 197) + '...' : text;
  }

  private normalizeQuery(query: string | undefined): string | undefined {
    if (!query) return undefined;
    return query
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '')
      .trim();
  }

  private generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }
}

/** Creates a {@link RetrievalService} with injected dependencies. */
export function createRetrievalService(options: RetrievalServiceOptions): RetrievalService {
  return new RetrievalServiceImpl(options);
}
