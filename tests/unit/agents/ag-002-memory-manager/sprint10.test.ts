import { describe, it, expect, beforeEach } from 'vitest';
import {
  CachedMemoryRepository,
  MemoryCache,
  MemoryConflictError,
  MemoryConfigurationError,
  MemoryEventType,
  MemoryLifecycleState,
  MemoryType,
  MemoryValidationError,
  StorageTier,
  createDurableCapabilities,
  createInMemoryCapabilities,
  createMemoryConsolidationService,
  createStorageAdapter,
  createDurableStorageAdapter,
  durableCapabilitiesFor,
  isDurableCapability,
  listDurableBackends,
  registerDurableBackend,
  MemoryIdempotencyRegistry,
  memoryCreateFingerprint,
  stableStringDigest,
  validateMemoryIdempotencyKey,
  createAuthorizationService,
  MemoryConfigSchema,
  InMemoryStorageAdapter,
  InMemoryMemoryRepository,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import type {
  MemoryRecord,
  MemoryStorageAdapter,
  DurableStorageAdapter,
  DurableWriteResult,
  MemoryConfig,
  StorageCapability,
  AtomicWork,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import {
  createTestConfig,
  createTestEnv,
  makeCreateInput,
  makeRecord,
  memoryManagerActor,
} from './fixtures.js';

const S = MemoryLifecycleState;

function configWith(partial: Partial<MemoryConfig>): MemoryConfig {
  return { ...createTestConfig(), ...partial };
}

/* ------------------------------------------------------------------ *
 *  Fake durable adapter (test double for the provider boundary only).
 * ------------------------------------------------------------------ */
class FakeDurableAdapter implements DurableStorageAdapter {
  readonly name = 'fake-durable';
  readonly durable = true as const;
  private readonly store = new Map<string, MemoryRecord>();
  private readonly ids = new Map<string, string>();

  private key(n: string, k: string): string {
    return `${n}\u0000${k}`;
  }

  async read(namespace: string, key: string): Promise<MemoryRecord | undefined> {
    const r = this.store.get(this.key(namespace, key));
    return r === undefined ? undefined : structuredClone(r);
  }

  async getById(id: string): Promise<MemoryRecord | undefined> {
    const address = this.ids.get(id);
    if (address === undefined) return undefined;
    const r = this.store.get(address);
    return r === undefined ? undefined : structuredClone(r);
  }

  async write(record: MemoryRecord): Promise<void> {
    this.store.set(this.key(record.namespace, record.key), structuredClone(record));
    this.ids.set(record.id, this.key(record.namespace, record.key));
  }

  async remove(namespace: string, key: string): Promise<boolean> {
    return this.store.delete(this.key(namespace, key));
  }

  async removeByNamespace(namespace: string): Promise<number> {
    const prefix = `${namespace}\u0000`;
    let n = 0;
    for (const k of Array.from(this.store.keys())) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
        n += 1;
      }
    }
    return n;
  }

  async list(): Promise<readonly MemoryRecord[]> {
    return Array.from(this.store.values()).map((r) => structuredClone(r));
  }

  capabilities() {
    return createDurableCapabilities('fake');
  }

  health() {
    return {
      healthy: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      stored: this.store.size,
      tiers: {
        [StorageTier.Hot]: 0,
        [StorageTier.Warm]: 0,
        [StorageTier.Cold]: 0,
      },
      message: 'ok',
    };
  }

  metrics() {
    return { reads: 0, writes: 0, conflicts: 0, queries: 0 };
  }

  transaction() {
    return {
      name: 'fake-transaction',
      run: async <T>(work: AtomicWork<T>): Promise<T> => work(),
    };
  }

  async durableWrite(record: MemoryRecord): Promise<DurableWriteResult> {
    await this.write(record);
    return { durablyPersisted: true, acknowledgedAt: '2026-01-01T00:00:00.000Z' };
  }

  async reload(namespace: string, key: string): Promise<MemoryRecord | undefined> {
    return this.read(namespace, key);
  }

  clear(): void {
    this.store.clear();
    this.ids.clear();
  }

  size(): number {
    return this.store.size;
  }
}

let durableRegistered = false;
function ensureFakeDurableRegistered(): void {
  if (durableRegistered) return;
  registerDurableBackend('fake', () => new FakeDurableAdapter());
  durableRegistered = true;
}

/* ================================================================== *
 *  A. Durable storage contracts
 * ================================================================== */
describe('Sprint 10 - durable storage contract', () => {
  beforeEach(() => {
    ensureFakeDurableRegistered();
  });

  it('registers and resolves a durable backend factory', () => {
    const adapter = createDurableStorageAdapter('fake');
    expect(adapter.durable).toBe(true);
    expect(adapter.name).toBe('fake-durable');
    expect(listDurableBackends()).toContain('fake');
  });

  it('durableWrite confirms durability and persists the record', async () => {
    const adapter = createDurableStorageAdapter('fake');
    const record = makeRecord({ namespace: 'user:1', key: 'dk' });
    const result = await adapter.durableWrite(record);
    expect(result.durablyPersisted).toBe(true);
    const reloaded = await adapter.reload('user:1', 'dk');
    expect(reloaded?.key).toBe('dk');
  });

  it('durableCapabilitiesFor returns a durable set for a registered backend', () => {
    ensureFakeDurableRegistered();
    const caps = durableCapabilitiesFor('fake');
    expect(caps).not.toBeNull();
    expect(caps?.capabilities).toContain('durable');
  });

  it('durableCapabilitiesFor returns null for an unknown backend', () => {
    const caps = durableCapabilitiesFor('does-not-exist');
    expect(caps).toBeNull();
  });

  it('fails closed for an unregistered durable backend', () => {
    // 'nope-404' is not a registered backend — resolution fails closed with a
    // typed configuration error (it must never fall back to non-durable storage).
    expect(() => createDurableStorageAdapter('nope-404')).toThrow(MemoryConfigurationError);
  });

  it('registers the real postgres backend and succeeds when the URL is available', () => {
    // postgres is wired as a real backend and the URL is present in .env,
    // so creating the adapter succeeds without throwing.
    expect(listDurableBackends()).toContain('postgres');
    const adapter = createDurableStorageAdapter('postgres');
    expect(adapter.durable).toBe(true);
  });

  it('fails closed for postgres when the URL is removed', () => {
    const saved = process.env.MEMORY_DATABASE_URL;
    try {
      delete process.env.MEMORY_DATABASE_URL;
      expect(() => createDurableStorageAdapter('postgres')).toThrow(MemoryConfigurationError);
    } finally {
      if (saved !== undefined) {
        process.env.MEMORY_DATABASE_URL = saved;
      }
    }
  });

  it('isDurableCapability identifies the durable capability', () => {
    expect(isDurableCapability('durable')).toBe(true);
    expect(isDurableCapability('read')).toBe(false);
  });
});

/* ================================================================== *
 *  B. Backend capability detection
 * ================================================================== */
describe('Sprint 10 - backend capability detection', () => {
  it('in-memory capabilities are NOT durable', () => {
    const caps = createInMemoryCapabilities();
    expect(caps.capabilities).not.toContain('durable');
    expect(caps.supports?.('durable')).toBe(false);
  });

  it('durable capabilities advertise durable/transactional/idempotent', () => {
    const caps = createDurableCapabilities('fake');
    expect(caps.capabilities).toEqual(
      expect.arrayContaining(['durable', 'transactional', 'idempotent', 'versionedWrite', 'query']),
    );
    expect(caps.supports?.('durable')).toBe(true);
  });

  it('createStorageAdapter returns the in-memory adapter by default', () => {
    const adapter = createStorageAdapter();
    expect(adapter).toBeInstanceOf(InMemoryStorageAdapter);
    expect(adapter.capabilities().supports?.('durable')).toBe(false);
  });

  it('createStorageAdapter resolves the durable postgres backend from the factory default', () => {
    // durable defaults to the real postgres backend (MEMORY_DATABASE_URL present
    // in .env), producing a genuinely durable adapter.
    const adapter = createStorageAdapter({
      MEMORY_STORAGE_BACKEND: 'durable',
    });
    expect(adapter.capabilities().supports?.('durable')).toBe(true);
  });

  it('createStorageAdapter fails closed for postgres when the URL is removed', () => {
    const saved = process.env.MEMORY_DATABASE_URL;
    try {
      delete process.env.MEMORY_DATABASE_URL;
      expect(() =>
        createStorageAdapter({
          MEMORY_STORAGE_BACKEND: 'durable',
          MEMORY_STORAGE_DURABLE_BACKEND: 'postgres',
        }),
      ).toThrow(MemoryConfigurationError);
    } finally {
      if (saved !== undefined) {
        process.env.MEMORY_DATABASE_URL = saved;
      }
    }
  });

  it('createStorageAdapter resolves a registered durable backend', () => {
    ensureFakeDurableRegistered();
    const adapter = createStorageAdapter({
      MEMORY_STORAGE_BACKEND: 'durable',
      MEMORY_STORAGE_DURABLE_BACKEND: 'fake',
    });
    expect(adapter.capabilities().supports?.('durable')).toBe(true);
  });

  it('exposes durable as part of the StorageCapability union', () => {
    const all: readonly StorageCapability[] = [
      'read',
      'write',
      'versionedWrite',
      'delete',
      'archive',
      'query',
      'pagination',
      'transactions',
      'durable',
      'idempotent',
      'transactional',
    ];
    expect(all).toContain('durable');
    expect(all).toContain('idempotent');
  });
});

/* ================================================================== *
 *  C. Persistence configuration
 * ================================================================== */
describe('Sprint 10 - persistence & cache configuration', () => {
  it('defaults for durable backend and cache settings', () => {
    const config = createTestConfig();
    expect(config.MEMORY_STORAGE_DURABLE_BACKEND).toBe('');
    expect(config.MEMORY_CACHE_ENABLED).toBe(true);
    expect(config.MEMORY_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
    expect(config.MEMORY_CACHE_TTL_MS).toBeGreaterThanOrEqual(0);
  });

  it('accepts an explicit durable backend name', () => {
    const config = MemoryConfigSchema.parse({ MEMORY_STORAGE_DURABLE_BACKEND: 'fake' });
    expect(config.MEMORY_STORAGE_DURABLE_BACKEND).toBe('fake');
  });

  it('accepts cache disabled mode', () => {
    expect(MemoryConfigSchema.parse({ MEMORY_CACHE_ENABLED: 'false' }).MEMORY_CACHE_ENABLED).toBe(
      false,
    );
  });

  it('rejects a zero cache max entries', () => {
    expect(() => MemoryConfigSchema.parse({ MEMORY_CACHE_MAX_ENTRIES: '0' })).toThrow();
  });
});

/* ================================================================== *
 *  D. Idempotent create
 * ================================================================== */
describe('Sprint 10 - idempotent create', () => {
  it('first create with an idempotency key succeeds', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({ idempotencyKey: 'req-1', key: 'k1' }),
    );
    expect(created.key).toBe('k1');
  });

  it('identical retry returns the existing record without a duplicate', async () => {
    const { service, repository } = createTestEnv();
    const first = await service.createMemory(
      makeCreateInput({ idempotencyKey: 'req-dup', key: 'k2' }),
    );
    const second = await service.createMemory(
      makeCreateInput({ idempotencyKey: 'req-dup', key: 'k2' }),
    );
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(1);
    const count = (await repository.list({ key: 'k2' })).length;
    expect(count).toBe(1);
  });

  it('identical retry does not emit a second Created event', async () => {
    const { service, events } = createTestEnv();
    await service.createMemory(makeCreateInput({ idempotencyKey: 'req-ev', key: 'k3' }));
    await events.clear();
    await service.createMemory(makeCreateInput({ idempotencyKey: 'req-ev', key: 'k3' }));
    const createdEvents = events.list().filter((e) => e.type === MemoryEventType.Created);
    expect(createdEvents).toHaveLength(0);
  });

  it('conflicting retry (different content, same key) fails with a conflict', async () => {
    const { service } = createTestEnv();
    await service.createMemory(
      makeCreateInput({ idempotencyKey: 'req-conf', key: 'k4', content: { v: 1 } }),
    );
    await expect(
      service.createMemory(
        makeCreateInput({ idempotencyKey: 'req-conf', key: 'k4', content: { v: 2 } }),
      ),
    ).rejects.toBeInstanceOf(MemoryConflictError);
  });

  it('conflicting retry (different key) fails with a conflict', async () => {
    const { service } = createTestEnv();
    await service.createMemory(
      makeCreateInput({ idempotencyKey: 'req-key', key: 'k5', content: { v: 1 } }),
    );
    await expect(
      service.createMemory(
        makeCreateInput({ idempotencyKey: 'req-key', key: 'k6', content: { v: 1 } }),
      ),
    ).rejects.toBeInstanceOf(MemoryConflictError);
  });

  it('the same idempotency key in another namespace is independent', async () => {
    const { service } = createTestEnv();
    const a = await service.createMemory(
      makeCreateInput({ idempotencyKey: 'ns-key', namespace: 'user:1', key: 'ka' }),
    );
    const b = await service.createMemory(
      makeCreateInput({ idempotencyKey: 'ns-key', namespace: 'project:1', key: 'kb' }),
    );
    expect(a.id).not.toBe(b.id);
  });

  it('a missing idempotency key keeps normal (non-idempotent) creation', async () => {
    const { service } = createTestEnv();
    const a = await service.createMemory(makeCreateInput({ key: 'plain-1' }));
    const b = await service.createMemory(makeCreateInput({ key: 'plain-2' }));
    expect(a.id).not.toBe(b.id);
  });

  it('rejects a malformed idempotency key', async () => {
    const { service } = createTestEnv();
    await expect(
      service.createMemory(makeCreateInput({ idempotencyKey: '   ' as unknown as string })),
    ).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it('rejects an empty idempotency key', async () => {
    const { service } = createTestEnv();
    await expect(
      service.createMemory(makeCreateInput({ idempotencyKey: '' as unknown as string })),
    ).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it('keeps version at 1 across identical retries', async () => {
    const { service } = createTestEnv();
    const first = await service.createMemory(
      makeCreateInput({ idempotencyKey: 'ver', key: 'k-ver' }),
    );
    const second = await service.createMemory(
      makeCreateInput({ idempotencyKey: 'ver', key: 'k-ver' }),
    );
    expect(first.version).toBe(1);
    expect(second.version).toBe(1);
  });
});

/* ================================================================== *
 *  E. Conflict handling (regression)
 * ================================================================== */
describe('Sprint 10 - conflict handling', () => {
  it('still conflicts on duplicate namespace/key without an idempotency key', async () => {
    const { service } = createTestEnv();
    await service.createMemory(makeCreateInput({ key: 'conf-plain' }));
    await expect(
      service.createMemory(makeCreateInput({ key: 'conf-plain' })),
    ).rejects.toBeInstanceOf(MemoryConflictError);
  });
});

/* ================================================================== *
 *  F. Concurrent create
 * ================================================================== */
describe('Sprint 10 - concurrent create', () => {
  it('concurrent identical creates with the same key settle on one record', async () => {
    const { service, repository } = createTestEnv();
    const [a, b] = await Promise.all([
      service.createMemory(
        makeCreateInput({ idempotencyKey: 'concurrent', key: 'kc', content: { v: 1 } }),
      ),
      service.createMemory(
        makeCreateInput({ idempotencyKey: 'concurrent', key: 'kc', content: { v: 1 } }),
      ),
    ]);
    const ids = new Set([a.id, b.id]);
    expect(ids.size).toBe(1);
    const count = (await repository.list({ key: 'kc' })).length;
    expect(count).toBe(1);
  });
});

/* ================================================================== *
 *  G/H/I/J/K/L/M - cache
 * ================================================================== */
describe('Sprint 10 - cache hit/miss & TTL', () => {
  it('reports a miss then a hit for a key/value', () => {
    const cache = new MemoryCache<string>({ enabled: true, maxEntries: 4 });
    expect(cache.get('a')).toBeUndefined();
    cache.set('a', '1');
    expect(cache.get('a')).toBe('1');
    expect(cache.metrics().hits).toBe(1);
    expect(cache.metrics().misses).toBe(1);
  });

  it('honours TTL and expires an entry', () => {
    const cache = new MemoryCache<string>({ enabled: true, maxEntries: 4, ttlMs: 100 });
    cache.nowRef = 1000;
    cache.set('a', '1');
    expect(cache.get('a')).toBe('1');
    cache.nowRef = 1200;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.metrics().expired).toBe(1);
  });

  it('is bounded and evicts LRU entries', () => {
    const cache = new MemoryCache<string>({ enabled: true, maxEntries: 2 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.get('a');
    cache.set('c', '3');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.metrics().evictions).toBe(1);
  });

  it('disabled mode is a transparent no-op', () => {
    const cache = new MemoryCache<string>({ enabled: false, maxEntries: 4 });
    cache.set('a', '1');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.active).toBe(false);
  });

  it('invalidateNamespace clears only that namespace prefix', () => {
    const cache = new MemoryCache<string>({ enabled: true, maxEntries: 8 });
    cache.set('user:1\u0000k', '1');
    cache.set('user:2\u0000k', '2');
    cache.invalidateNamespace('user:1');
    expect(cache.get('user:1\u0000k')).toBeUndefined();
    expect(cache.get('user:2\u0000k')).toBe('2');
  });
});

describe('Sprint 10 - cached memory repository', () => {
  function makeCached() {
    const storage = new InMemoryStorageAdapter();
    const repository = new InMemoryMemoryRepository(storage);
    const cache = new MemoryCache<MemoryRecord>({ enabled: true, maxEntries: 64 });
    const cached = new CachedMemoryRepository(repository, cache);
    return { storage, repository, cache, cached };
  }

  function seedRecord(): MemoryRecord {
    return makeRecord({ namespace: 'user:1', key: 'rk' });
  }

  it('caches get and serves a clone (immutability safe)', async () => {
    const { cached, repository, cache } = makeCached();
    const record = seedRecord();
    await repository.create(record);
    const first = await cached.get('user:1', 'rk');
    const second = await cached.get('user:1', 'rk');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const mutableFirst = first as unknown as { content: Record<string, unknown> };
    mutableFirst.content.hacked = true;
    const third = await cached.get('user:1', 'rk');
    expect((third!.content as { hacked?: boolean }).hacked).toBeUndefined();
    expect(cache.metrics().hits).toBe(2);
  });

  it('update invalidates the cached by-address and by-id entries', async () => {
    const { cached, repository } = makeCached();
    const record = seedRecord();
    await repository.create(record);
    await cached.get('user:1', 'rk'); // populate cache
    await cached.getById(record.id); // populate by-id
    const updated = { ...record, version: 2, content: { new: true } };
    await cached.update('user:1', 'rk', 1, updated);
    const read = await cached.get('user:1', 'rk');
    expect(read!.version).toBe(2);
  });

  it('save invalidates cache (covers archive/restore lifecycle writes)', async () => {
    const { cached, repository } = makeCached();
    const record = seedRecord();
    await repository.create(record);
    await cached.get('user:1', 'rk');
    const archived = { ...record, lifecycle: S.Archived };
    await cached.save(archived);
    const read = await cached.get('user:1', 'rk');
    expect(read!.lifecycle).toBe(S.Archived);
  });

  it('eraseById invalidates cache so erased records cannot return', async () => {
    const { cached, repository } = makeCached();
    const record = seedRecord();
    await repository.create(record);
    await cached.get('user:1', 'rk');
    await cached.getById(record.id);
    await cached.eraseById(record.id);
    const viaAddress = await cached.get('user:1', 'rk');
    const viaId = await cached.getById(record.id);
    expect(viaAddress).toBeUndefined();
    expect(viaId).toBeUndefined();
  });

  it('eraseByNamespace invalidates the whole namespace', async () => {
    const { cached, repository } = makeCached();
    await repository.create(seedRecord());
    await cached.get('user:1', 'rk');
    await cached.eraseByNamespace('user:1');
    expect(await cached.get('user:1', 'rk')).toBeUndefined();
  });

  it('does not leak values across namespaces (namespace-safe keys)', async () => {
    const { cached, repository } = makeCached();
    await repository.create({ ...seedRecord(), namespace: 'user:1' });
    await repository.create({ ...seedRecord(), namespace: 'project:1' });
    await cached.get('user:1', 'rk');
    await cached.get('project:1', 'rk');
    // Distinct namespace entries coexist without collision.
    expect(await cached.get('user:1', 'rk')).toBeDefined();
    expect(await cached.get('project:1', 'rk')).toBeDefined();
  });
});

/* ================================================================== *
 *  N/O - consolidation canonical path & stale sources
 * ================================================================== */
describe('Sprint 10 - canonical consolidation & stale-source detection', () => {
  it('produces a deterministic key and does not duplicate on repeat', async () => {
    const storage = new InMemoryStorageAdapter();
    const repository = new InMemoryMemoryRepository(storage);
    const config = MemoryConfigSchema.parse({ MEMORY_CONSOLIDATION_ENABLED: 'true' });
    const service = createMemoryConsolidationService({
      repository,
      authorizationService: createAuthorizationService(),
      config,
    });
    const rec1 = makeRecord({ namespace: 'user:1', type: MemoryType.Conversation, key: 'ca' });
    const rec2 = makeRecord({ namespace: 'user:1', type: MemoryType.Conversation, key: 'cb' });
    await repository.create(rec1);
    await repository.create(rec2);
    const policy = {
      archiveSources: false,
      minRecords: 2,
      maxRecords: 20,
      allowedTypes: [MemoryType.Conversation] as const,
    };
    const first = await service.consolidate({
      actor: memoryManagerActor,
      namespace: 'user:1',
      policy,
      reason: 'group',
    });
    expect(first.statistics.recordsCreated).toBe(1);
    const second = await service.consolidate({
      actor: memoryManagerActor,
      namespace: 'user:1',
      policy,
      reason: 'repeat',
    });
    expect(second.statistics.recordsCreated).toBe(0);
    expect(second.statistics.conflicts).toBe(1);
  });
});

/* ================================================================== *
 *  P/Q/R - event duplication, failure recovery, regression
 * ================================================================== */
describe('Sprint 10 - failure recovery & regression', () => {
  it('memoryCreateFingerprint is stable and distinguishes content', () => {
    const a = memoryCreateFingerprint({ namespace: 'n', key: 'k', content: { x: 1 } });
    const b = memoryCreateFingerprint({ namespace: 'n', key: 'k', content: { x: 1 } });
    const c = memoryCreateFingerprint({ namespace: 'n', key: 'k', content: { x: 2 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('stableStringDigest is deterministic and fixed length', () => {
    const a = stableStringDigest('hello');
    const b = stableStringDigest('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('validates idempotency keys', () => {
    expect(validateMemoryIdempotencyKey('abc-123')).toBe('abc-123');
    expect(() => validateMemoryIdempotencyKey('  ')).toThrow();
    expect(() => validateMemoryIdempotencyKey('')).toThrow();
  });

  it('the idempotency registry isolates by namespace', () => {
    const registry = new MemoryIdempotencyRegistry();
    registry.set('user:1', 'key', { namespace: 'user:1', key: 'a', fingerprint: 'f1' });
    const user2 = registry.get('user:2', 'key');
    expect(user2).toBeUndefined();
    const user1 = registry.get('user:1', 'key');
    expect(user1?.key).toBe('a');
  });

  it('the service emits a single Created event on first create', async () => {
    const { service, events } = createTestEnv();
    await service.createMemory(makeCreateInput({ key: 'one-ev' }));
    const created = events.list().filter((e) => e.type === MemoryEventType.Created);
    expect(created).toHaveLength(1);
  });

  it('the service operates correctly with cache disabled', async () => {
    const { service } = createTestEnv({ config: configWith({ MEMORY_CACHE_ENABLED: false }) });
    const created = await service.createMemory(
      makeCreateInput({ key: 'nocache', idempotencyKey: 'nc' }),
    );
    const again = await service.createMemory(
      makeCreateInput({ key: 'nocache', idempotencyKey: 'nc' }),
    );
    expect(again.id).toBe(created.id);
  });

  it('cache metrics never expose keys or values', () => {
    const cache = new MemoryCache<MemoryRecord>({ enabled: true, maxEntries: 4 });
    cache.set('user:1\u0000k', makeRecord());
    const m = cache.metrics();
    expect(Object.keys(m)).toEqual(['size', 'hits', 'misses', 'evictions', 'expired']);
    expect(m.size).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 *  Bucket that simply exercises the durable adapter memory path.
 * ------------------------------------------------------------------ */
describe('Sprint 10 - durable adapter read/write passthrough', () => {
  it('a memory-backed durable adapter persists then returns records', async () => {
    const adapter: MemoryStorageAdapter = new FakeDurableAdapter();
    const record = makeRecord({ namespace: 'user:1', key: 'rd' });
    await adapter.write(record);
    expect((await adapter.read('user:1', 'rd'))?.id).toBe(record.id);
    expect(adapter.size()).toBe(1);
    await adapter.remove('user:1', 'rd');
    expect(adapter.size()).toBe(0);
  });
});
