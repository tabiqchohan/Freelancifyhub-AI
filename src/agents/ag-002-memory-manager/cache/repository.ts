import type {
  MemoryId,
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';
import type { MemoryRepository } from '../repositories/index.js';
import type { RepositoryPage, RepositoryQuery } from '../repositories/query.js';
import type {
  MemoryStorageCapabilities,
  MemoryStorageMetrics,
  StorageHealth,
} from '../storage/capabilities.js';
import { byIdCacheKey, namespaceAddressKey } from './index.js';
import type { MemoryCache } from './index.js';

/**
 * Sprint 10 — read-through, write-invalidating repository cache decorator.
 *
 * Caches `get`, `getById` and `exists` reads keyed by namespace-scoped address.
 * Every mutating operation (create/save/update/delete/eraseById/eraseByNamespace)
 * deterministically invalidates the affected cache entries, which also covers
 * archive/restore/expire lifecycle writes that flow through `save`/`update`.
 *
 * SAFETY: this decorator is a pure value cache. It never evaluates or caches
 * authorization decisions — those remain in the service layer, which authorizes
 * before calling the repository. Erasure invalidates the erased id/namespace, so
 * erased records cannot resurface through the cache.
 */
export class CachedMemoryRepository implements MemoryRepository {
  readonly name = 'cached-memory-repository';

  private readonly inner: MemoryRepository;
  private readonly cache: MemoryCache<MemoryRecord>;

  constructor(inner: MemoryRepository, cache: MemoryCache<MemoryRecord>) {
    this.inner = inner;
    this.cache = cache;
  }

  private getAddressKey(namespace: MemoryNamespace, key: MemoryKey): string {
    return namespaceAddressKey(namespace, key);
  }

  async create(record: MemoryRecord): Promise<MemoryRecord> {
    const created = await this.inner.create(record);
    this.invalidateFor(record.namespace, record.key, record.id);
    return created;
  }

  async get(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined> {
    const address = this.getAddressKey(namespace, key);
    const cached = this.cache.get(address);
    if (cached !== undefined) {
      return structuredClone(cached);
    }
    const record = await this.inner.get(namespace, key);
    if (record !== undefined) {
      // Store a fresh clone so callers mutating the returned record never
      // corrupt the cached copy (immutability contract).
      this.cache.set(address, structuredClone(record));
    }
    return record;
  }

  async getById(id: MemoryId): Promise<MemoryRecord | undefined> {
    const key = byIdCacheKey(id);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return structuredClone(cached);
    }
    const record = await this.inner.getById(id);
    if (record !== undefined) {
      this.cache.set(key, structuredClone(record));
    }
    return record;
  }

  async save(record: MemoryRecord): Promise<MemoryRecord> {
    const stored = await this.inner.save(record);
    this.invalidateFor(record.namespace, record.key, record.id);
    return stored;
  }

  async update(
    namespace: MemoryNamespace,
    key: MemoryKey,
    expectedVersion: number,
    record: MemoryRecord,
  ): Promise<MemoryRecord> {
    const updated = await this.inner.update(namespace, key, expectedVersion, record);
    this.invalidateFor(record.namespace, record.key, record.id);
    return updated;
  }

  async delete(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    const removed = await this.inner.delete(namespace, key);
    if (removed) {
      this.cache.invalidate(this.getAddressKey(namespace, key));
    }
    return removed;
  }

  async eraseById(id: MemoryId): Promise<boolean> {
    // Capture the erased record's address before removal so we can invalidate it.
    const existing = await this.inner.getById(id);
    const removed = await this.inner.eraseById(id);
    if (removed) {
      this.cache.invalidate(byIdCacheKey(id));
      if (existing !== undefined) {
        this.cache.invalidate(this.getAddressKey(existing.namespace, existing.key));
      }
    }
    return removed;
  }

  async eraseByNamespace(namespace: MemoryNamespace): Promise<number> {
    const removed = await this.inner.eraseByNamespace(namespace);
    if (removed > 0) {
      this.cache.invalidateNamespace(namespace);
    }
    return removed;
  }

  async list(filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]> {
    return this.inner.list(filter);
  }

  async query(query: RepositoryQuery): Promise<RepositoryPage> {
    return this.inner.query(query);
  }

  async count(filter?: MemoryRecordFilter): Promise<number> {
    return this.inner.count(filter);
  }

  async exists(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    // Short-circuit from the cache to avoid a storage round-trip where possible.
    const address = this.getAddressKey(namespace, key);
    if (this.cache.get(address) !== undefined) {
      return true;
    }
    const found = await this.inner.exists(namespace, key);
    return found;
  }

  capabilities(): MemoryStorageCapabilities {
    return this.inner.capabilities();
  }

  health(): StorageHealth {
    return this.inner.health();
  }

  metrics(): MemoryStorageMetrics {
    return this.inner.metrics();
  }

  private invalidateFor(namespace: MemoryNamespace, key: MemoryKey, id: MemoryId): void {
    this.cache.invalidate(this.getAddressKey(namespace, key));
    this.cache.invalidate(byIdCacheKey(id));
  }
}

/** Decorator factory offered with the cache decorator. */
export function cacheRepository(
  repository: MemoryRepository,
  cache: MemoryCache<MemoryRecord>,
): MemoryRepository {
  return new CachedMemoryRepository(repository, cache);
}
