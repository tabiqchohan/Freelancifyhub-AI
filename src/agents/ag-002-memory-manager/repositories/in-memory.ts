import { MemoryLifecycleState } from '../enums/index.js';
import { MemoryConflictError, MemoryNotFoundError } from '../errors/index.js';
import type { MemoryRepository } from './index.js';
import type { RepositoryPage, RepositoryQuery } from './query.js';
import {
  compareRecordsSorted,
  decodeRepositoryCursor,
  encodeRepositoryCursor,
  recordAfterCursor,
  sortValueOf,
  validateRepositoryQuery,
} from './query.js';
import type {
  MemoryStorageCapabilities,
  MemoryStorageMetrics,
  StorageHealth,
} from '../storage/capabilities.js';
import { createInMemoryCapabilities } from '../storage/capabilities.js';
import { InMemoryStorageAdapter } from '../storage/in-memory.js';
import type { MemoryStorageAdapter } from '../storage/index.js';
import type {
  MemoryId,
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';

/**
 * Deterministic in-memory repository.
 *
 * TEST / IN-MEMORY INFRASTRUCTURE ONLY. Wraps an in-memory storage adapter and
 * enforces record/id uniqueness plus version-guarded updates. It is not
 * production persistence and is fully replaceable via the {@link MemoryRepository}
 * contract.
 *
 * Sprint 6: implements deterministic paginated queries, by-id reads, declared
 * capabilities, runtime health and safe metrics. Authorization is never
 * performed here.
 */
export class InMemoryMemoryRepository implements MemoryRepository {
  readonly name = 'in-memory-memory-repository';

  private readonly storage: MemoryStorageAdapter;
  private readonly ids = new Map<string, string>();
  private conflictCount = 0;

  constructor(storage: MemoryStorageAdapter = new InMemoryStorageAdapter()) {
    this.storage = storage;
  }

  private addressOf(namespace: MemoryNamespace, key: MemoryKey): string {
    return `${namespace}\u0000${key}`;
  }

  async create(record: MemoryRecord): Promise<MemoryRecord> {
    const existing = await this.storage.read(record.namespace, record.key);
    if (existing !== undefined && existing.lifecycle !== MemoryLifecycleState.Deleted) {
      this.conflictCount += 1;
      throw new MemoryConflictError(
        `Memory already exists at namespace ${record.namespace} key ${record.key}`,
        { details: { namespace: record.namespace, key: record.key } },
      );
    }

    const taken = this.ids.get(record.id);
    if (taken !== undefined) {
      this.conflictCount += 1;
      throw new MemoryConflictError(`Memory id ${record.id} is already in use`, {
        details: { id: record.id },
      });
    }

    await this.storage.write(record);
    this.ids.set(record.id, this.addressOf(record.namespace, record.key));
    return record;
  }

  async get(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined> {
    return this.storage.read(namespace, key);
  }

  async getById(id: MemoryId): Promise<MemoryRecord | undefined> {
    return this.storage.getById(id);
  }

  async save(record: MemoryRecord): Promise<MemoryRecord> {
    await this.storage.write(record);
    this.ids.set(record.id, this.addressOf(record.namespace, record.key));
    return record;
  }

  async update(
    namespace: MemoryNamespace,
    key: MemoryKey,
    expectedVersion: number,
    record: MemoryRecord,
  ): Promise<MemoryRecord> {
    const existing = await this.storage.read(namespace, key);
    if (existing === undefined) {
      throw new MemoryNotFoundError(`Memory not found at namespace ${namespace} key ${key}`, {
        details: { namespace, key },
      });
    }
    if (existing.version !== expectedVersion) {
      this.conflictCount += 1;
      throw new MemoryConflictError(
        `Memory version conflict at namespace ${namespace} key ${key}: expected ${expectedVersion}, found ${existing.version}`,
        { details: { namespace, key, expectedVersion, foundVersion: existing.version } },
      );
    }

    await this.storage.write(record);
    return record;
  }

  async delete(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    const removed = await this.storage.remove(namespace, key);
    if (removed) {
      const address = this.addressOf(namespace, key);
      for (const [id, storedAddress] of this.ids) {
        if (storedAddress === address) {
          this.ids.delete(id);
        }
      }
    }
    return removed;
  }

  async list(filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]> {
    return this.storage.list(undefined, filter);
  }

  async query(input: RepositoryQuery): Promise<RepositoryPage> {
    const query = validateRepositoryQuery(input);
    const all = await this.storage.list(undefined, query.filter);
    const total = all.length;
    const sorted = [...all].sort((a, b) => compareRecordsSorted(a, b, query.sort));

    let start = 0;
    if (query.cursor !== undefined) {
      const { sort, last } = decodeRepositoryCursor(query.cursor);
      let rec = sorted[start];
      while (rec !== undefined && !recordAfterCursor(rec, sort, last)) {
        start += 1;
        rec = sorted[start];
      }
    }

    const items = sorted.slice(start, start + query.limit);
    const hasMore = start + query.limit < sorted.length;
    let nextCursor: string | undefined;
    if (hasMore) {
      const lastRec = items[items.length - 1];
      if (lastRec !== undefined) {
        nextCursor = encodeRepositoryCursor(query.sort, {
          value: sortValueOf(lastRec, query.sort.field),
          namespace: lastRec.namespace,
          key: lastRec.key,
        });
      }
    }

    return { items, nextCursor, hasMore, total, pageSize: items.length };
  }

  async count(filter?: MemoryRecordFilter): Promise<number> {
    return (await this.storage.list(undefined, filter)).length;
  }

  async exists(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    return (await this.storage.read(namespace, key)) !== undefined;
  }

  capabilities(): MemoryStorageCapabilities {
    return createInMemoryCapabilities();
  }

  health(): StorageHealth {
    return this.storage.health();
  }

  metrics(): MemoryStorageMetrics {
    const storageMetrics = this.storage.metrics();
    return { ...storageMetrics, conflicts: this.conflictCount };
  }
}
