import type { MemoryRecord } from '../types/index.js';
import type { MemoryRetrievalQuery } from './index.js';
import type { MemoryRepository } from '../repositories/index.js';

/**
 * Candidate retriever contract for future-proof retrieval (Sprint 4, prompt §28).
 * Abstracts the source of candidate memories so the retrieval pipeline can
 * support vector search, hybrid search, or other strategies without changes.
 */
export interface CandidateRetriever {
  readonly name: string;
  retrieve(query: MemoryRetrievalQuery, callerScope: readonly string[]): Promise<readonly MemoryRecord[]>;
}

/**
 * Repository-based candidate retriever (current implementation).
 * Uses the existing repository abstraction to fetch candidates.
 */
export class RepositoryCandidateRetriever implements CandidateRetriever {
  readonly name = 'repository-candidate-retriever';

  private readonly repository: MemoryRepository;

  constructor(repository: MemoryRepository) {
    this.repository = repository;
  }

  async retrieve(query: MemoryRetrievalQuery, callerScope: readonly string[]): Promise<readonly MemoryRecord[]> {
    const filter = { ...query.filters, namespace: query.namespace };
    const all = await this.repository.list(filter);

    return all.filter(
      (record) => callerScope.includes(record.namespace)
    );
  }
}