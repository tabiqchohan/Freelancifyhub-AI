import { describe, expect, it } from 'vitest';

import {
  MemoryLifecycleState,
  MemoryPriority,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import { MemoryValidationError } from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import { InMemoryMemoryRetrievalEngine } from '../../../../src/agents/ag-002-memory-manager/retrieval/in-memory.js';
import { InMemoryMemoryRepository } from '../../../../src/agents/ag-002-memory-manager/repositories/in-memory.js';
import { makeRecord } from './fixtures.js';

async function seededEngine() {
  const repo = new InMemoryMemoryRepository();
  const engine = new InMemoryMemoryRetrievalEngine(repo);
  await repo.create(
    makeRecord({
      namespace: 'user:1',
      key: 'pref_theme',
      type: MemoryType.User,
      priority: MemoryPriority.Critical,
      content: { theme: 'dark' },
    }),
  );
  await repo.create(
    makeRecord({
      namespace: 'user:1',
      key: 'conv_tail',
      type: MemoryType.Conversation,
      priority: MemoryPriority.High,
      content: { text: 'hello' },
    }),
  );
  return { repo, engine };
}

describe('InMemoryMemoryRetrievalEngine - filtering (spec §8, prompt §13)', () => {
  it('returns only records in the caller scope (fail-closed)', async () => {
    const { engine } = await seededEngine();
    const results = await engine.search({ namespace: 'user:1' }, ['user:99']);
    expect(results).toEqual([]);
  });

  it('respects attribute filters', async () => {
    const { engine } = await seededEngine();
    const results = await engine.search(
      { namespace: 'user:1', filters: { type: MemoryType.User } },
      ['user:1'],
    );
    expect(results.map((r) => r.record.key)).toEqual(['pref_theme']);
  });

  it('excludes deleted and expired records', async () => {
    const { repo, engine } = await seededEngine();
    await repo.save(
      makeRecord({ namespace: 'user:1', key: 'gone', lifecycle: MemoryLifecycleState.Deleted }),
    );
    await repo.save(
      makeRecord({
        namespace: 'user:1',
        key: 'old',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:00:01.000Z',
      }),
    );
    const results = await engine.search({ namespace: 'user:1' }, ['user:1']);
    const keys = results.map((r) => r.record.key);
    expect(keys).not.toContain('gone');
    expect(keys).not.toContain('old');
  });

  it('honours the keyword query over keys and metadata (no content inspection)', async () => {
    const { repo, engine } = await seededEngine();
    await repo.save(
      makeRecord({ namespace: 'user:1', key: 'note', metadata: { topic: 'invoice' } }),
    );
    const results = await engine.search({ namespace: 'user:1', query: 'invoice' }, ['user:1']);
    expect(results.map((r) => r.record.key)).toEqual(['note']);
    const none = await engine.search({ namespace: 'user:1', query: 'zzzz' }, ['user:1']);
    expect(none).toEqual([]);
  });
});

describe('InMemoryMemoryRetrievalEngine - deterministic ordering', () => {
  it('orders by priority (critical first) then recency', async () => {
    const repo = new InMemoryMemoryRepository();
    const engine = new InMemoryMemoryRetrievalEngine(repo);
    await repo.save(makeRecord({ namespace: 'user:1', key: 'low', priority: MemoryPriority.Low }));
    await repo.save(
      makeRecord({ namespace: 'user:1', key: 'crit', priority: MemoryPriority.Critical }),
    );
    await repo.save(
      makeRecord({ namespace: 'user:1', key: 'med', priority: MemoryPriority.Medium }),
    );
    const results = await engine.search({ namespace: 'user:1' }, ['user:1']);
    expect(results.map((r) => r.record.key)).toEqual(['crit', 'med', 'low']);
  });

  it('respects the limit and rejects invalid limits', async () => {
    const repo = new InMemoryMemoryRepository();
    const engine = new InMemoryMemoryRetrievalEngine(repo);
    await repo.save(makeRecord({ namespace: 'user:1', key: 'a' }));
    await repo.save(makeRecord({ namespace: 'user:1', key: 'b' }));
    expect((await engine.search({ namespace: 'user:1', limit: 1 }, ['user:1'])).length).toBe(1);
    await expect(
      engine.search({ namespace: 'user:1', limit: 0 }, ['user:1']),
    ).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it('assigns deterministic priority-derived scores', async () => {
    const { engine } = await seededEngine();
    const results = await engine.search({ namespace: 'user:1' }, ['user:1']);
    const critical = results.find((r) => r.record.key === 'pref_theme');
    expect(critical?.score).toBe(1);
    const conversation = results.find((r) => r.record.key === 'conv_tail');
    expect(conversation?.score).toBe(0.75);
  });
});
