import type { MemoryNamespace, MemoryRecord, MemoryRecordFilter } from '../types/index.js';

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
