import { describe, expect, it } from 'vitest';

import {
  InMemoryMemoryRepository,
  InMemoryStorageAdapter,
  MemoryConfigSchema,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryPriority,
  MemoryType,
  MemoryValidationError,
  MemoryConflictError,
  StorageTier,
  createStorageAdapter,
  parseMemoryRecord,
  serializeMemoryRecord,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import { makeOwner, makeRecord } from './fixtures.js';

function makeStorage(): { storage: InMemoryStorageAdapter; repository: InMemoryMemoryRepository } {
  const storage = new InMemoryStorageAdapter();
  const repository = new InMemoryMemoryRepository(storage);
  return { storage, repository };
}

describe('Sprint 6 - durable read by id (prompt §12)', () => {
  it('reads a persisted record by its globally-unique id', async () => {
    const { repository } = makeStorage();
    const record = makeRecord({ id: 'id-1', key: 'k1' });
    await repository.create(record);
    const found = await repository.getById('id-1');
    expect(found).toMatchObject({ id: 'id-1', namespace: record.namespace, key: 'k1' });
  });

  it('returns undefined for an unknown id', async () => {
    const { repository } = makeStorage();
    await expect(repository.getById('missing')).resolves.toBeUndefined();
  });

  it('does not resolve an id that was deleted', async () => {
    const { repository } = makeStorage();
    await repository.create(makeRecord({ id: 'id-2', key: 'k2' }));
    await repository.delete('user:1', 'k2');
    await expect(repository.getById('id-2')).resolves.toBeUndefined();
  });
});

describe('Sprint 6 - deterministic paginated query (prompt §3-§4)', () => {
  async function seed(): Promise<{ repository: InMemoryMemoryRepository }> {
    const { repository } = makeStorage();
    for (let i = 0; i < 6; i += 1) {
      await repository.create(
        makeRecord({ key: `k_${i}`, createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
      );
    }
    return { repository };
  }

  it('sorts by createdAt ascending by default', async () => {
    const { repository } = await seed();
    const page = await repository.query({
      filter: { namespace: 'user:1' },
      maxPageSize: 50,
    });
    expect(page.items.map((r) => r.key)).toEqual(['k_0', 'k_1', 'k_2', 'k_3', 'k_4', 'k_5']);
    expect(page.total).toBe(6);
    expect(page.hasMore).toBe(false);
    expect(page.pageSize).toBe(6);
  });

  it('paginates deterministically with a cursor and no overlap', async () => {
    const { repository } = await seed();
    const first = await repository.query({
      filter: { namespace: 'user:1' },
      limit: 2,
      maxPageSize: 50,
    });
    expect(first.items.map((r) => r.key)).toEqual(['k_0', 'k_1']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();

    const second = await repository.query({
      filter: { namespace: 'user:1' },
      limit: 2,
      maxPageSize: 50,
      cursor: first.nextCursor,
    });
    expect(second.items.map((r) => r.key)).toEqual(['k_2', 'k_3']);
    expect(second.hasMore).toBe(true);

    const third = await repository.query({
      filter: { namespace: 'user:1' },
      limit: 2,
      maxPageSize: 50,
      cursor: second.nextCursor,
    });
    expect(third.items.map((r) => r.key)).toEqual(['k_4', 'k_5']);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeUndefined();
  });

  it('sorts by priority descending', async () => {
    const { repository } = makeStorage();
    await repository.create(makeRecord({ key: 'low', priority: MemoryPriority.Low }));
    await repository.create(makeRecord({ key: 'high', priority: MemoryPriority.High }));
    await repository.create(makeRecord({ key: 'crit', priority: MemoryPriority.Critical }));
    const page = await repository.query({
      limit: 10,
      maxPageSize: 50,
      sort: { field: 'priority', direction: 'desc' },
    });
    expect(page.items.map((r) => r.key)).toEqual(['crit', 'high', 'low']);
  });

  it('sorts by key ascending for stable lexicographic ordering', async () => {
    const { repository } = makeStorage();
    await repository.create(makeRecord({ key: 'banana' }));
    await repository.create(makeRecord({ key: 'apple' }));
    await repository.create(makeRecord({ key: 'cherry' }));
    const page = await repository.query({
      limit: 10,
      maxPageSize: 50,
      sort: { field: 'key', direction: 'asc' },
    });
    expect(page.items.map((r) => r.key)).toEqual(['apple', 'banana', 'cherry']);
  });

  it('returns only records matching the filter', async () => {
    const { repository } = makeStorage();
    await repository.create(makeRecord({ key: 'a', type: MemoryType.User, namespace: 'user:1' }));
    await repository.create(
      makeRecord({ key: 'b', type: MemoryType.Conversation, namespace: 'user:1' }),
    );
    const page = await repository.query({
      filter: { namespace: 'user:1', type: MemoryType.User },
      limit: 10,
      maxPageSize: 50,
    });
    expect(page.items.map((r) => r.key)).toEqual(['a']);
    expect(page.total).toBe(1);
  });
});

describe('Sprint 6 - query validation failures (prompt §3)', () => {
  it('rejects a non-positive page size', async () => {
    const { repository } = makeStorage();
    await expect(repository.query({ maxPageSize: 0 })).rejects.toThrow(MemoryValidationError);
  });

  it('rejects a limit larger than the configured maximum', async () => {
    const { repository } = makeStorage();
    await expect(repository.query({ limit: 100, maxPageSize: 50 })).rejects.toThrow(
      MemoryValidationError,
    );
  });

  it('rejects a malformed cursor with INVALID_CURSOR', async () => {
    const { repository } = makeStorage();
    await expect(
      repository.query({ maxPageSize: 50, cursor: 'not-a-valid-cursor' }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});

describe('Sprint 6 - declared capabilities (prompt §11)', () => {
  it('reports the full in-memory capability set', () => {
    const { repository } = makeStorage();
    const caps = repository.capabilities();
    expect(caps.backend).toBe('in-memory');
    expect(caps.capabilities).toEqual(
      expect.arrayContaining([
        'read',
        'write',
        'versionedWrite',
        'delete',
        'query',
        'pagination',
        'transactions',
      ]),
    );
    expect(caps.supports?.('pagination')).toBe(true);
    expect(caps.supports?.('transactions')).toBe(true);
  });
});

describe('Sprint 6 - runtime health (prompt §11)', () => {
  it('reports healthy with accurate stored counts and tiers', async () => {
    const { repository } = makeStorage();
    await repository.create(makeRecord({ key: 'hot-1' }));
    const archived = makeRecord({ key: 'cold-1', lifecycle: MemoryLifecycleState.Archived });
    await repository.create(archived);
    const health = repository.health();
    expect(health.healthy).toBe(true);
    expect(health.stored).toBe(2);
    expect(health.tiers[StorageTier.Hot]).toBe(1);
    expect(health.tiers[StorageTier.Cold]).toBe(1);
    expect(typeof health.checkedAt).toBe('string');
  });
});

describe('Sprint 6 - safe metrics (prompt §15)', () => {
  it('counts storage reads, writes and queries', async () => {
    const { repository } = makeStorage();
    await repository.create(makeRecord({ key: 'm1' }));
    await repository.create(makeRecord({ key: 'm2' }));
    await repository.get('user:1', 'm1');
    const before = repository.metrics();
    expect(before.reads).toBeGreaterThanOrEqual(1);
    expect(before.writes).toBeGreaterThanOrEqual(2);

    await repository.list();
    const after = repository.metrics();
    expect(after.queries).toBeGreaterThan(before.queries);
  });

  it('tracks conflicts raised on version mismatch and id reuse', async () => {
    const { repository } = makeStorage();
    await repository.create(makeRecord({ id: 'dup-id', key: 'v1', version: 1 }));
    const existing = (await repository.getById('dup-id'))!;
    await expect(
      repository.update('user:1', 'v1', 99, { ...existing, version: 2 }),
    ).rejects.toThrow(MemoryConflictError);
    await expect(repository.create(makeRecord({ id: 'dup-id', key: 'v2' }))).rejects.toThrow(
      MemoryConflictError,
    );
    expect(repository.metrics().conflicts).toBeGreaterThanOrEqual(2);
  });
});

describe('Sprint 6 - transaction boundary (prompt §7)', () => {
  it('commits work when the transaction succeeds', async () => {
    const { storage } = makeStorage();
    const tx = storage.transaction();
    await tx.run(async () => {
      await storage.write(makeRecord({ key: 'tx-ok' }));
    });
    expect(storage.size()).toBe(1);
  });

  it('rolls back all writes when the transaction throws', async () => {
    const { storage } = makeStorage();
    const tx = storage.transaction();
    await expect(
      tx.run(async () => {
        await storage.write(makeRecord({ key: 'tx-a' }));
        await storage.write(makeRecord({ key: 'tx-b' }));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(storage.size()).toBe(0);
    await expect(storage.read('user:1', 'tx-a')).resolves.toBeUndefined();
    await expect(storage.read('user:1', 'tx-b')).resolves.toBeUndefined();
  });

  it('leaves concurrent state intact on failure', async () => {
    const { storage } = makeStorage();
    await storage.write(makeRecord({ key: 'outside' }));
    const tx = storage.transaction();
    await expect(
      tx.run(async () => {
        await storage.write(makeRecord({ key: 'tx-c' }));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(storage.size()).toBe(1);
    await expect(storage.read('user:1', 'outside')).resolves.toBeDefined();
  });
});

describe('Sprint 6 - storage adapter factory (prompt §12)', () => {
  it('returns the in-memory adapter by default', () => {
    const adapter = createStorageAdapter();
    expect(adapter.name).toBe('in-memory-memory-storage');
  });

  it('honours the configured backend identifier', () => {
    const adapter = createStorageAdapter({ MEMORY_STORAGE_BACKEND: 'in-memory' });
    expect(adapter.name).toBe('in-memory-memory-storage');
  });

  it('fails closed on an unknown backend', () => {
    const config = MemoryConfigSchema.parse({ MEMORY_STORAGE_BACKEND: 'postgres' });
    expect(() =>
      createStorageAdapter({ MEMORY_STORAGE_BACKEND: config.MEMORY_STORAGE_BACKEND }),
    ).toThrow(/Unsupported storage backend/);
  });
});

describe('Sprint 6 - serialization prototype-pollution guard (§10)', () => {
  it('rejects __proto__ in record content during serialization', () => {
    const tainted = makeRecord({
      content: { safe: 1, nested: JSON.parse('{"__proto__":{"polluted":true}}') },
    });
    expect(() => serializeMemoryRecord(tainted)).toThrow(/forbidden property key/);
  });

  it('rejects constructor keys in metadata', () => {
    const tainted = makeRecord({ metadata: JSON.parse('{"constructor":{"evil":"yes"}}') });
    expect(() => serializeMemoryRecord(tainted)).toThrow(/forbidden property key/);
  });

  it('round-trips a clean record without pollution artefacts', () => {
    const record = makeRecord({ key: 'clean', content: { ok: true } });
    const parsed = parseMemoryRecord(serializeMemoryRecord(record));
    expect(parsed.key).toBe('clean');
    expect(parsed.content).toEqual({ ok: true });
  });
});

describe('Sprint 6 - stress: deterministic order under volume (prompt §3)', () => {
  it('paginates a large set in stable order without loss or duplication', async () => {
    const { repository } = makeStorage();
    const total = 127;
    for (let i = 0; i < total; i += 1) {
      await repository.create(
        makeRecord({
          key: `s_${String(i).padStart(3, '0')}`,
          createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
          owner: makeOwner(MemoryOwnerKind.User, String(i)),
        }),
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.query({
        filter: { namespace: 'user:1' },
        limit: 10,
        maxPageSize: 50,
        sort: { field: 'key', direction: 'asc' },
        cursor,
      });
      seen.push(...page.items.map((r) => r.key));
      cursor = page.nextCursor;
      expect(page.pageSize).toBeLessThanOrEqual(10);
    } while (cursor !== undefined);

    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual([...seen].sort());
  });
});
