import type { MemoryNamespace, MemoryRecord, MemoryRecordFilter } from '../types/index.js';

import { MemoryType } from '../enums/index.js';

/**
 * Future retrieval contract (spec §8, §19, prompt §13). Designed to support
 * metadata filtering, memory-type filtering, ownership filtering, security
 * filtering, priority filtering and relevance/ranking — all replaceable behind
 * the interface. No embeddings or vector search in this sprint.
 */

/** A retrieval query scoped to a namespace. */
export interface MemoryRetrievalQuery {
  readonly namespace: MemoryNamespace;
  /** Keyword query (deterministic substring match in the in-memory engine). */
  readonly query?: string;
  /** Attribute filters applied before ranking. */
  readonly filters?: MemoryRecordFilter;
  readonly limit?: number;
}

/** A single retrieval hit: record plus a deterministic score. */
export interface MemoryRetrievalResult {
  readonly record: MemoryRecord;
  /** 0..1 deterministic score. Full ranking formula (spec §8) is deferred. */
  readonly score: number;
  /** Optional excerpt. Never emitted to logs. */
  readonly snippet?: string;
}

/**
 * Retrieval contract. `callerScope` is the caller's namespace allow-list;
 * results outside it are excluded (fail-closed, spec §7).
 */
export interface MemoryRetrievalEngine {
  readonly name: string;
  search(
    query: MemoryRetrievalQuery,
    callerScope: readonly MemoryNamespace[],
  ): Promise<readonly MemoryRetrievalResult[]>;
}

/**
 * Sprint 4: Retrieval Service contracts (prompts §2-§3, §15, §27).
 * These contracts support metadata filtering, memory-type filtering, ownership
 * filtering, security filtering, priority filtering and relevance/ranking.
 * No embeddings or vector search in this sprint.
 */

/** A retrieval request with actor scoping and configuration. */
export interface RetrievalRequest {
  readonly actor: import('../security/index.js').MemoryActor;
  readonly query?: string;
  readonly namespace: MemoryNamespace;
  readonly types?: readonly MemoryType[];
  readonly scopes?: readonly string[];
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly organizationId?: string;
  readonly maxResults?: number;
  readonly minScore?: number;
  readonly contextBudgetTokens?: number;
  readonly priorities?: readonly import('../enums/index.js').MemoryPriority[];
  readonly filters?: MemoryRecordFilter;
  readonly traceId?: string;
}

/** A single retrieval hit with a deterministic score. */
export interface RetrievalResult {
  readonly record: MemoryRecord;
  readonly score: number;
  readonly snippet?: string;
}

/** Retrieval statistics from a pipeline run. */
export interface RetrievalStatistics {
  readonly candidateCount: number;
  readonly authorizedCount: number;
  readonly selectedCount: number;
  readonly filteredCount: number;
  readonly truncatedCount: number;
}

/** Retrieval metadata (trace and duration). */
export interface RetrievalMetadata {
  readonly traceId: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

/** Full retrieval response. */
export interface RetrievalResponse {
  readonly results: readonly RetrievalResult[];
  readonly statistics: RetrievalStatistics;
  readonly metadata: RetrievalMetadata;
}

/** Retrieval service contract. */
export interface RetrievalService {
  readonly name: string;
  readonly version: string;
  retrieve(request: RetrievalRequest): Promise<RetrievalResponse>;
}

/** Retrieval pipeline configuration. */
export interface RetrievalPipelineConfig {
  readonly maxResults: number;
  readonly minScore: number;
  readonly contextBudgetTokens: number;
  readonly priorities?: readonly import('../enums/index.js').MemoryPriority[];
}

/** Candidate retriever for future vector compatibility (prompt §28). */
export interface CandidateRetriever {
  readonly name: string;
  retrieve(query: MemoryRetrievalQuery, callerScope: readonly string[]): Promise<readonly MemoryRecord[]>;
}

/** Scorer for deterministic relevance scoring (prompt §11). */
export interface Scorer {
  readonly name: string;
  score(record: MemoryRecord, query: string, now: Date): number;
}

/** Token estimator for context budgeting (prompt §17). */
export interface TokenEstimator {
  readonly name: string;
  estimate(record: MemoryRecord): number;
  estimateText(text: string): number;
}

/** Query normalizer (prompt §10). */
export interface QueryNormalizer {
  readonly name: string;
  normalize(query: string): string;
}

/** Retrieval service options. */
export interface RetrievalServiceOptions {
  readonly repository: import('../repositories/index.js').MemoryRepository;
  readonly authorizationService: import('../security/index.js').AuthorizationService;
  readonly config?: import('../config/schema.js').MemoryConfig;
  readonly clock?: import('../clock/index.js').Clock;
  readonly logger?: import('pino').Logger;
  readonly pipelineConfig?: Partial<RetrievalPipelineConfig>;
}
