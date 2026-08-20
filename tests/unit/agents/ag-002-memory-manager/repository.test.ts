import { describe, expect, it } from 'vitest';

import {
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import {
  MemoryConflictError,
  MemoryNotFoundError,
} from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import { InMemoryMemoryRepository } from '../../../../src/agents/ag-002-memory-manager/repositories/in-memory.js';
import { makeOwner, makeRecord } from './fixtures.js';

describe('InMemoryMemoryRepository - CRUD (prompt §11, §20)', () => {
  it('creates and reads records', async () => {
    const repo = new InMemoryMemoryRepository();
    const record = makeRecord({ namespace: 'user:1', key: 'theme' });
    await repo.create(record);
    expect(await repo.get('user:1', 'theme')).toEqual(record);
    expect(await repo.exists('user:1', 'theme')).toBe(true);
  });

  it('throws a conflict on duplicate namespace+key', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(makeRecord({ namespace: 'user:1', key: 'theme' }));
    await expect(
      repo.create(makeRecord({ namespace: 'user:1', key: 'theme' })),
    ).rejects.toBeInstanceOf(MemoryConflictError);
  });

  it('enforces unique ids across different keys (AC-MEM-7)', async () => {
    const repo = new InMemoryMemoryRepository();
    const first = makeRecord({ id: 'memory_dup', namespace: 'user:1', key: 'a' });
    await repo.create(first);
    await expect(
      repo.create(makeRecord({ id: 'memory_dup', namespace: 'user:1', key: 'b' })),
    ).rejects.toBeInstanceOf(MemoryConflictError);
  });

  it('allows recreating a deleted (tombstone) key', async () => {
    const repo = new InMemoryMemoryRepository();
    const record = makeRecord({
      namespace: 'user:1',
      key: 'theme',
      lifecycle: MemoryLifecycleState.Deleted,
    });
    await repo.create(record);
    const recreated = makeRecord({ namespace: 'user:1', key: 'theme' });
    expect(await repo.create(recreated)).toEqual(recreated);
  });

  it('returns undefined for missing records and counts filtered results', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(makeRecord({ namespace: 'user:1', key: 'a', type: MemoryType.User }));
    await repo.create(makeRecord({ namespace: 'user:1', key: 'b', type: MemoryType.Conversation }));
    expect(await repo.get('user:1', 'missing')).toBeUndefined();
    expect(await repo.count()).toBe(2);
    expect(await repo.count({ type: MemoryType.User })).toBe(1);
    expect((await repo.list({ type: MemoryType.Conversation })).map((r) => r.key)).toEqual(['b']);
  });

  it('deletes records physically and reports existence', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(makeRecord({ namespace: 'user:1', key: 'theme' }));
    expect(await repo.delete('user:1', 'theme')).toBe(true);
    expect(await repo.delete('user:1', 'theme')).toBe(false);
    expect(await repo.exists('user:1', 'theme')).toBe(false);
  });

  it('filters by owner kind and id', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(
      makeRecord({ namespace: 'user:1', key: 'a', owner: makeOwner(MemoryOwnerKind.User, '1') }),
    );
    await repo.create(
      makeRecord({ namespace: 'user:2', key: 'b', owner: makeOwner(MemoryOwnerKind.User, '2') }),
    );
    expect(
      (await repo.list({ owner: makeOwner(MemoryOwnerKind.User, '2') })).map((r) => r.key),
    ).toEqual(['b']);
  });
});

describe('InMemoryMemoryRepository - versioned updates (prompt §21, spec §15)', () => {
  it('updates only when the expected version matches', async () => {
    const repo = new InMemoryMemoryRepository();
    const v1 = makeRecord({ namespace: 'user:1', key: 'theme', version: 1 });
    await repo.create(v1);
    const v2 = makeRecord({ namespace: 'user:1', key: 'theme', version: 2 });
    expect(await repo.update('user:1', 'theme', 1, v2)).toEqual(v2);
    expect((await repo.get('user:1', 'theme'))?.version).toBe(2);
  });

  it('throws a conflict on version mismatch (409 semantics)', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(makeRecord({ namespace: 'user:1', key: 'theme', version: 1 }));
    await expect(
      repo.update(
        'user:1',
        'theme',
        5,
        makeRecord({ namespace: 'user:1', key: 'theme', version: 6 }),
      ),
    ).rejects.toBeInstanceOf(MemoryConflictError);
  });

  it('throws not-found when updating a missing key', async () => {
    const repo = new InMemoryMemoryRepository();
    await expect(
      repo.update('user:1', 'missing', 1, makeRecord({ namespace: 'user:1', key: 'missing' })),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });
});
