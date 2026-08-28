import { describe, expect, it } from 'vitest';

import {
  InMemoryMemoryRepository,
  InMemoryStorageAdapter,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryType,
  MemoryConflictError,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import type { MemoryJsonValue } from '../../../../src/agents/ag-002-memory-manager/index.js';
import { makeOwner, makeRecord } from './fixtures.js';

function makeStorage(): { storage: InMemoryStorageAdapter; repository: InMemoryMemoryRepository } {
  const storage = new InMemoryStorageAdapter();
  const repository = new InMemoryMemoryRepository(storage);
  return { repository, storage };
}

describe('Sprint 6 - lifecycle repository version-safety (X)', () => {
  it('persists an active -> archived transition via a version-safe update', async () => {
    const { repository } = makeStorage();
    const record = makeRecord({
      key: 'life-arch',
      lifecycle: MemoryLifecycleState.Active,
      version: 3,
    });
    await repository.create(record);
    const archived = { ...record, lifecycle: MemoryLifecycleState.Archived, version: 4 };
    const stored = await repository.update('user:1', 'life-arch', 3, archived);
    expect(stored.version).toBe(4);
    expect((await repository.get('user:1', 'life-arch'))?.lifecycle).toBe(
      MemoryLifecycleState.Archived,
    );
  });

  it('rejects a stale version when persisting a lifecycle transition', async () => {
    const { repository } = makeStorage();
    const record = makeRecord({
      key: 'life-stale',
      lifecycle: MemoryLifecycleState.Active,
      version: 1,
    });
    await repository.create(record);
    await repository.update('user:1', 'life-stale', 1, {
      ...record,
      lifecycle: MemoryLifecycleState.Archived,
      version: 2,
    });
    // A second transition using the now-stale version 1 must fail.
    await expect(
      repository.update('user:1', 'life-stale', 1, {
        ...record,
        lifecycle: MemoryLifecycleState.Expired,
        version: 2,
      }),
    ).rejects.toThrow(MemoryConflictError);
  });

  it('allows recreating a deleted tombstone but not a live record', async () => {
    const { repository } = makeStorage();
    const tombstone = makeRecord({ key: 'tomb', lifecycle: MemoryLifecycleState.Deleted });
    await repository.save(tombstone);
    // A deleted tombstone may be reused (idempotent recreate path).
    await expect(
      repository.create(makeRecord({ key: 'tomb', lifecycle: MemoryLifecycleState.Active })),
    ).resolves.toBeDefined();

    const live = makeRecord({ key: 'live', lifecycle: MemoryLifecycleState.Active });
    await repository.create(live);
    await expect(
      repository.create(makeRecord({ key: 'live', lifecycle: MemoryLifecycleState.Active })),
    ).rejects.toThrow(MemoryConflictError);
  });

  it('reading a lifecycle record never exposes mutable internal state', async () => {
    const { repository } = makeStorage();
    const record = makeRecord({ key: 'life-stable', owner: makeOwner(MemoryOwnerKind.User, '7') });
    await repository.create(record);
    const read = (await repository.get('user:1', 'life-stable'))!;
    // Mutating the object handed back to the caller must not corrupt the store.
    const content = read.content as { text: string };
    content.text = 'mutated';
    const stored = (await repository.get('user:1', 'life-stable'))!;
    expect((stored.content as { text: string }).text).toBe('hello');
    (stored.metadata as Record<string, unknown>).evil = true;
    expect((await repository.get('user:1', 'life-stable'))?.metadata).not.toHaveProperty('evil');
  });
});

describe('Sprint 6 - sensitive data does not leak through storage (AJ)', () => {
  it('storage conflict errors never embed secret values or raw content', async () => {
    const { repository } = makeStorage();
    const record = makeRecord({
      key: 'secretly',
      content: { nested: { apiKey: 'sk-live-9f2c', token: 'abc-tok', passphrase: 'hunter2' } },
    });
    await repository.create(record);

    try {
      await repository.update('user:1', 'secretly', 999, { ...record, version: 2 });
      throw new Error('expected a conflict');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('user:1');
      expect(message).toContain('secretly');
      for (const leaked of ['sk-live-9f2c', 'abc-tok', 'hunter2', 'nested']) {
        expect(message).not.toContain(leaked);
      }
    }
  });

  it('create conflict errors carry only identifiers, not content', async () => {
    const { repository } = makeStorage();
    await repository.create(makeRecord({ key: 'dup-secret', content: { pwd: 'very-secret' } }));
    const attempt = repository.create(
      makeRecord({ key: 'dup-secret', id: 'other', content: { pwd: 'x' } }),
    );
    await expect(attempt).rejects.toThrow(MemoryConflictError);
    try {
      await repository.create(
        makeRecord({ key: 'dup-secret', id: 'other2', content: { pwd: 'y' } }),
      );
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('very');
      expect(message).not.toContain('pwd');
    }
  });
});

describe('Sprint 6 - stress (AL/AO/AM/AN)', () => {
  it('returns stable results across many repeated queries', async () => {
    const { repository } = makeStorage();
    for (let i = 0; i < 40; i += 1) {
      await repository.create(makeRecord({ key: `q_${i}`, type: MemoryType.User }));
    }
    const baseline = await repository.query({ limit: 50, maxPageSize: 50 });
    for (let q = 0; q < 100; q += 1) {
      const again = await repository.query({ limit: 50, maxPageSize: 50 });
      expect(again.items.map((r) => r.key)).toEqual(baseline.items.map((r) => r.key));
    }
  });

  it('duplicate-heavy creates raise typed conflicts without corrupting the store', async () => {
    const { repository } = makeStorage();
    await repository.create(makeRecord({ key: 'dup-heavy', id: 'dup-heavy-1' }));
    let conflicts = 0;
    for (let i = 0; i < 50; i += 1) {
      try {
        await repository.create(makeRecord({ key: 'dup-heavy', id: `dup-heavy-x${i}` }));
      } catch (error) {
        if (error instanceof MemoryConflictError) {
          conflicts += 1;
        }
      }
    }
    expect(conflicts).toBe(50);
    expect((await repository.get('user:1', 'dup-heavy'))?.id).toBe('dup-heavy-1');
  });

  it('many stale sequential version updates all fail except the first', async () => {
    const { repository } = makeStorage();
    const record = makeRecord({ key: 'seq-stale', version: 1 });
    await repository.create(record);

    let failures = 0;
    for (let i = 0; i < 5; i += 1) {
      try {
        await repository.update('user:1', 'seq-stale', 1, { ...record, version: i + 2 });
      } catch (error) {
        if (error instanceof MemoryConflictError) {
          failures += 1;
        }
      }
    }
    // Only the first sequential update (expectedVersion 1 == stored 1) succeeds.
    expect(failures).toBe(4);
  });

  it('large nested metadata round-trips losslessly', async () => {
    const { repository } = makeStorage();
    const big: Record<string, MemoryJsonValue> = {};
    for (let i = 0; i < 200; i += 1) {
      big[`field_${i}`] = JSON.parse(
        `{"nested":{"i":${i},"list":[${i},${i + 1}],"deep":{"ok":${i}}}}`,
      );
    }
    const record = makeRecord({ key: 'big-meta', metadata: big });
    await repository.create(record);
    const stored = await repository.get('user:1', 'big-meta');
    expect(stored?.metadata).toEqual(big);
    expect(Object.keys(stored?.metadata ?? {}).length).toBe(200);
  });
});
