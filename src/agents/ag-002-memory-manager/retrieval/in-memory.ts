import { MemoryLifecycleState, MemoryPriority } from '../enums/index.js';
import { MemoryValidationError } from '../errors/index.js';
import type { MemoryRepository } from '../repositories/index.js';
import { isMemoryExpired } from '../retention/index.js';
import type {
  MemoryRetrievalEngine,
  MemoryRetrievalQuery,
  MemoryRetrievalResult,
} from './index.js';
import type { MemoryNamespace, MemoryRecord } from '../types/index.js';

const PRIORITY_RANK: Readonly<Record<MemoryPriority, number>> = {
  [MemoryPriority.Critical]: 4,
  [MemoryPriority.High]: 3,
  [MemoryPriority.Medium]: 2,
  [MemoryPriority.Low]: 1,
};

/**
 * Deterministic in-memory retrieval engine.
 *
 * TEST / IN-MEMORY INFRASTRUCTURE ONLY. Performs scope-filtered, attribute
 * filtered retrieval with deterministic ordering (priority then recency). The
 * architecture's weighted ranking formula (spec §8) and vector similarity are
 * intentionally deferred; scores here are deterministic priority-derived
 * values so ordering is stable across runs.
 */
export class InMemoryMemoryRetrievalEngine implements MemoryRetrievalEngine {
  readonly name = 'in-memory-memory-retrieval';

  private readonly repository: MemoryRepository;

  constructor(repository: MemoryRepository) {
    this.repository = repository;
  }

  async search(
    query: MemoryRetrievalQuery,
    callerScope: readonly MemoryNamespace[],
  ): Promise<readonly MemoryRetrievalResult[]> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new MemoryValidationError('Retrieval limit must be an integer between 1 and 1000', {
        details: { limit },
      });
    }

    const filter = { ...query.filters, namespace: query.namespace };
    const all = await this.repository.list(filter);

    const inScope = all.filter(
      (record) =>
        callerScope.includes(record.namespace) &&
        record.lifecycle !== MemoryLifecycleState.Deleted &&
        !isMemoryExpired(record),
    );

    const matched =
      query.query === undefined
        ? inScope
        : inScope.filter((record) => this.matchesQuery(record, query.query ?? ''));

    const ordered = [...matched].sort(
      (a, b) =>
        PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
        b.updatedAt.localeCompare(a.updatedAt),
    );

    return ordered.slice(0, limit).map((record) => ({
      record,
      score: PRIORITY_RANK[record.priority] / 4,
    }));
  }

  private matchesQuery(record: MemoryRecord, query: string): boolean {
    const needle = query.toLowerCase();
    const haystack = [
      record.key,
      record.type,
      ...Object.values(record.metadata).filter(
        (value): value is string => typeof value === 'string',
      ),
    ];
    return haystack.some((value) => value.toLowerCase().includes(needle));
  }
}
