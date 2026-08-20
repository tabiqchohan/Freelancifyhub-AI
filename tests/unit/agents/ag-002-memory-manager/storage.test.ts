import { describe, expect, it } from 'vitest';

import {
  MemoryLifecycleState,
  MemoryPriority,
  MemoryType,
  StorageTier,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import { InMemoryStorageAdapter } from '../../../../src/agents/ag-002-memory-manager/storage/in-memory.js';
import { tierForRecord } from '../../../../src/agents/ag-002-memory-manager/storage/index.js';
import { makeRecord } from './fixtures.js';

describe('InMemoryStorageAdapter - deterministic storage (prompt §12, §20)', () => {
  it('stores and reads records by namespace+key', async () => {
    const storage = new InMemoryStorageAdapter();
    const record = makeRecord({ namespace: 'user:1', key: 'theme' });
    await storage.write(record);
    expect(await storage.read('user:1', 'theme')).toEqual(record);
    expect(await storage.read('user:1', 'missing')).toBeUndefined();
  });

  it('is namespaced: same key in different namespaces does not collide', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.write(makeRecord({ namespace: 'user:1', key: 'theme', content: { v: 1 } }));
    await storage.write(makeRecord({ namespace: 'user:2', key: 'theme', content: { v: 2 } }));
    expect((await storage.read('user:1', 'theme'))?.content).toEqual({ v: 1 });
    expect((await storage.read('user:2', 'theme'))?.content).toEqual({ v: 2 });
  });

  it('removes records and reports whether they existed', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.write(makeRecord({ namespace: 'user:1', key: 'theme' }));
    expect(await storage.remove('user:1', 'theme')).toBe(true);
    expect(await storage.remove('user:1', 'theme')).toBe(false);
    expect(await storage.read('user:1', 'theme')).toBeUndefined();
  });

  it('lists records with optional tier and attribute filters', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.write(makeRecord({ namespace: 'user:1', key: 'a', type: MemoryType.User }));
    await storage.write(
      makeRecord({
        namespace: 'user:1',
        key: 'b',
        type: MemoryType.Conversation,
        lifecycle: MemoryLifecycleState.Archived,
      }),
    );
    const hot = await storage.list(StorageTier.Hot);
    const cold = await storage.list(StorageTier.Cold);
    expect(hot.map((r) => r.key)).toEqual(['a']);
    expect(cold.map((r) => r.key)).toEqual(['b']);
    expect((await storage.list(undefined, { type: MemoryType.User })).map((r) => r.key)).toEqual([
      'a',
    ]);
  });

  it('supports clear and size helpers', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.write(makeRecord({ namespace: 'user:1', key: 'a' }));
    await storage.write(makeRecord({ namespace: 'user:1', key: 'b' }));
    expect(storage.size()).toBe(2);
    storage.clear();
    expect(storage.size()).toBe(0);
  });

  it('isolates stored records from caller mutation (clone on write/read)', async () => {
    const storage = new InMemoryStorageAdapter();
    const record = makeRecord({ namespace: 'user:1', key: 'theme', content: { v: 1 } });
    await storage.write(record);
    (record.content as unknown as { v: number }).v = 999;
    const readBack = await storage.read('user:1', 'theme');
    expect((readBack?.content as unknown as { v: number }).v).toBe(1);
  });
});

describe('tierForRecord - storage tiering (spec §18)', () => {
  it('maps archived records to cold and everything else to hot', () => {
    expect(tierForRecord(makeRecord({ lifecycle: MemoryLifecycleState.Archived }))).toBe(
      StorageTier.Cold,
    );
    expect(tierForRecord(makeRecord({ lifecycle: MemoryLifecycleState.Active }))).toBe(
      StorageTier.Hot,
    );
    expect(tierForRecord(makeRecord({ lifecycle: MemoryLifecycleState.Deleted }))).toBe(
      StorageTier.Hot,
    );
    expect(tierForRecord(makeRecord({ priority: MemoryPriority.Critical }))).toBe(StorageTier.Hot);
  });
});
