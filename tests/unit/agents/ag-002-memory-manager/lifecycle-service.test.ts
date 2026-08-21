import { describe, expect, it } from 'vitest';

import {
  FixedClock,
  type Clock,
} from '../../../../src/agents/ag-002-memory-manager/clock/index.js';
import {
  MemoryConfigSchema,
  type MemoryConfig,
} from '../../../../src/agents/ag-002-memory-manager/config/schema.js';
import {
  MemoryLifecycleState,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import {
  MemoryAccessDeniedError,
  MemoryConfigurationError,
  MemoryConflictError,
  MemoryNotFoundError,
} from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import {
  InMemoryMemoryEventEmitter,
  MemoryEventType,
} from '../../../../src/agents/ag-002-memory-manager/events/index.js';
import { DefaultMemoryLifecycle } from '../../../../src/agents/ag-002-memory-manager/lifecycle/index.js';
import { InMemoryMemoryRepository } from '../../../../src/agents/ag-002-memory-manager/repositories/in-memory.js';
import type { MemoryRepository } from '../../../../src/agents/ag-002-memory-manager/repositories/index.js';
import {
  DefaultMemoryRetentionEvaluator,
  MemoryRetentionDecision,
} from '../../../../src/agents/ag-002-memory-manager/retention/index.js';
import { InMemoryMemoryRetrievalEngine } from '../../../../src/agents/ag-002-memory-manager/retrieval/in-memory.js';
import { MatrixMemoryAccessPolicy } from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import { createMemoryLifecycleService } from '../../../../src/agents/ag-002-memory-manager/services/lifecycle.service.js';
import { createMemoryManagerService } from '../../../../src/agents/ag-002-memory-manager/services/memory.service.js';
import { InMemoryStorageAdapter } from '../../../../src/agents/ag-002-memory-manager/storage/in-memory.js';
import type {
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../../../../src/agents/ag-002-memory-manager/types/index.js';
import { clientActor, createTestConfig, makeRecord, memoryManagerActor } from './fixtures.js';

const S = MemoryLifecycleState;
const NOW = '2026-06-01T00:00:00.000Z';
const PAST = '2026-03-01T00:00:00.000Z';

/** Simulates a concurrent writer bumping the stored version between read and write. */
class RacingRepository implements MemoryRepository {
  readonly name = 'racing-repository';

  constructor(private readonly inner: MemoryRepository) {}

  async create(record: MemoryRecord): Promise<MemoryRecord> {
    return this.inner.create(record);
  }

  async get(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined> {
    const record = await this.inner.get(namespace, key);
    if (record !== undefined) {
      await this.inner.save({ ...record, version: record.version + 1 });
    }
    return record;
  }

  async save(record: MemoryRecord): Promise<MemoryRecord> {
    return this.inner.save(record);
  }

  async update(
    namespace: MemoryNamespace,
    key: MemoryKey,
    expectedVersion: number,
    record: MemoryRecord,
  ): Promise<MemoryRecord> {
    return this.inner.update(namespace, key, expectedVersion, record);
  }

  async delete(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    return this.inner.delete(namespace, key);
  }

  async list(filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]> {
    return this.inner.list(filter);
  }

  async count(filter?: MemoryRecordFilter): Promise<number> {
    return this.inner.count(filter);
  }

  async exists(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    return this.inner.exists(namespace, key);
  }
}

function createLifecycleEnv(options: { clock?: Clock; config?: MemoryConfig } = {}) {
  const storage = new InMemoryStorageAdapter();
  const repository = new InMemoryMemoryRepository(storage);
  const accessPolicy = new MatrixMemoryAccessPolicy();
  const lifecycle = new DefaultMemoryLifecycle();
  const retrieval = new InMemoryMemoryRetrievalEngine(repository);
  const events = new InMemoryMemoryEventEmitter();
  const config = options.config ?? createTestConfig();
  const clock = options.clock ?? new FixedClock(NOW);
  const lifecycleService = createMemoryLifecycleService({
    repository,
    lifecycle,
    retention: new DefaultMemoryRetentionEvaluator(),
    accessPolicy,
    config,
    clock,
    events,
  });
  const manager = createMemoryManagerService({
    repository,
    accessPolicy,
    lifecycle,
    retrievalEngine: retrieval,
    config,
    clock,
    events,
  });
  return {
    repository,
    storage,
    accessPolicy,
    lifecycle,
    events,
    config,
    clock,
    lifecycleService,
    manager,
  };
}

function expiredConversation(overrides: Parameters<typeof makeRecord>[0] = {}) {
  return makeRecord({
    key: 'k_conv',
    type: MemoryType.Conversation,
    retention: { kind: 'rolling_window' },
    expiresAt: PAST,
    ...overrides,
  });
}

describe('Lifecycle service - evaluate (J, prompt §11)', () => {
  it('returns a decision without mutating the stored record', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation());
    const evaluation = await lifecycleService.evaluate({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
    });
    expect(evaluation.decision).toBe(MemoryRetentionDecision.ARCHIVE);
    const stored = await repository.get('user:1', 'k_conv');
    expect(stored?.version).toBe(1);
    expect(stored?.lifecycle).toBe(S.Active);
  });

  it('keeps a live, non-expired record', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(makeRecord({ key: 'k_conv', type: MemoryType.Conversation }));
    const evaluation = await lifecycleService.evaluate({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
    });
    expect(evaluation.decision).toBe(MemoryRetentionDecision.KEEP);
  });

  it('throws MemoryNotFoundError for a missing record', async () => {
    const { lifecycleService } = createLifecycleEnv();
    await expect(
      lifecycleService.evaluate({ actor: memoryManagerActor, namespace: 'user:1', key: 'missing' }),
    ).rejects.toThrow(MemoryNotFoundError);
  });
});

describe('Lifecycle service - run transitions (H/I, prompt §10, §13)', () => {
  it('archives an expired conversation via a version-safe transition', async () => {
    const { repository, lifecycleService, events } = createLifecycleEnv();
    await repository.save(expiredConversation());
    const outcome = await lifecycleService.run({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
      reason: 'retention sweep',
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.record?.lifecycle).toBe(S.Archived);
    expect(outcome.record?.version).toBe(2);
    const stored = await repository.get('user:1', 'k_conv');
    expect(stored?.lifecycle).toBe(S.Archived);
    expect(stored?.version).toBe(2);
    const archived = events.list().find((event) => event.type === MemoryEventType.Archived);
    expect(archived).toBeDefined();
    expect(archived?.memoryId).toBe(stored?.id);
    expect(archived?.previousState).toBe(S.Active);
    expect(archived?.newState).toBe(S.Archived);
    expect(archived?.version).toBe(2);
    expect(archived?.reason).toBe('retention sweep');
  });

  it('logically deletes an expired temporary record', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(
      makeRecord({
        key: 'k_temp',
        type: MemoryType.Temporary,
        retention: { kind: 'none' },
        expiresAt: PAST,
      }),
    );
    const outcome = await lifecycleService.run({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_temp',
      reason: 'sweeper on TTL',
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.record?.lifecycle).toBe(S.Deleted);
    expect(outcome.record?.version).toBe(2);
    expect(outcome.record?.content).toEqual({ text: 'hello' });
  });

  it('expires an expired generic record into the EXPIRED state', async () => {
    const { repository, lifecycleService, events } = createLifecycleEnv();
    await repository.save(
      makeRecord({
        key: 'k_st',
        type: MemoryType.ShortTerm,
        retention: { kind: 'until_deletion' },
        expiresAt: PAST,
      }),
    );
    const outcome = await lifecycleService.run({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_st',
      reason: 'TTL exceeded',
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.record?.lifecycle).toBe(S.Expired);
    const expired = events.list().find((event) => event.type === MemoryEventType.Expired);
    expect(expired).toBeDefined();
    expect(expired?.previousState).toBe(S.Active);
    expect(expired?.newState).toBe(S.Expired);
  });

  it('does not change a record the evaluator wants to keep', async () => {
    const { repository, lifecycleService, events } = createLifecycleEnv();
    await repository.save(makeRecord({ key: 'k_conv', type: MemoryType.Conversation }));
    const outcome = await lifecycleService.run({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
      reason: 'sweep',
    });
    expect(outcome.changed).toBe(false);
    expect(outcome.record).toBeUndefined();
    expect(events.list()).toHaveLength(0);
  });

  it('treats a second run on an EXPIRED generic record as a no-op', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(
      makeRecord({
        key: 'k_st',
        type: MemoryType.ShortTerm,
        retention: { kind: 'until_deletion' },
        expiresAt: PAST,
      }),
    );
    const input = {
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_st',
      reason: 'sweep',
    };
    const first = await lifecycleService.run(input);
    expect(first.changed).toBe(true);
    const second = await lifecycleService.run(input);
    expect(second.changed).toBe(false);
  });

  it('is a no-op on an already-deleted record (terminal)', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(
      makeRecord({
        key: 'k_conv',
        type: MemoryType.Conversation,
        lifecycle: S.Deleted,
        expiresAt: PAST,
      }),
    );
    const outcome = await lifecycleService.run({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
      reason: 'sweep',
    });
    expect(outcome.changed).toBe(false);
  });

  it('throws MemoryNotFoundError for a missing record', async () => {
    const { lifecycleService } = createLifecycleEnv();
    await expect(
      lifecycleService.run({
        actor: memoryManagerActor,
        namespace: 'user:1',
        key: 'missing',
        reason: 'sweep',
      }),
    ).rejects.toThrow(MemoryNotFoundError);
  });
});

describe('Lifecycle service - events (K/L, prompt §12, §16)', () => {
  it('emits content-free events stamped by the injected clock', async () => {
    const { repository, lifecycleService, events, clock } = createLifecycleEnv();
    await repository.save(expiredConversation({ content: { apiKey: 'hunter2' } }));
    const traceId = 'trace_lifecycle';
    await lifecycleService.run({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
      reason: 'sweep',
      traceId,
    });
    const archived = events.list().find((event) => event.type === MemoryEventType.Archived);
    expect(archived?.traceId).toBe(traceId);
    expect(archived?.occurredAt).toBe(clock.getNow().toISOString());
    expect(JSON.stringify(archived)).not.toContain('hunter2');
  });

  it('delivers events to subscribed handlers', async () => {
    const { repository, lifecycleService, events } = createLifecycleEnv();
    await repository.save(expiredConversation());
    const seen: string[] = [];
    const unsubscribe = events.on((event) => seen.push(event.type));
    await lifecycleService.run({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
      reason: 'sweep',
    });
    expect(seen).toContain(MemoryEventType.Archived);
    unsubscribe();
  });

  it('propagates lifecycle events through the memory manager facade', async () => {
    const { repository, manager, events } = createLifecycleEnv();
    await repository.save(expiredConversation());
    const outcome = await manager.runLifecycle({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
      reason: 'sweep',
    });
    expect(outcome.changed).toBe(true);
    expect(events.list().some((event) => event.type === MemoryEventType.Archived)).toBe(true);
  });

  it('exposes batch lifecycle through the memory manager facade', async () => {
    const { repository, manager } = createLifecycleEnv();
    await repository.save(expiredConversation({ key: 'k_a' }));
    await repository.save(expiredConversation({ key: 'k_b' }));
    const results = await manager.runBatchLifecycle({ actor: memoryManagerActor });
    expect(results.map((result) => result.record?.key)).toEqual(['k_a', 'k_b']);
  });
});

describe('Lifecycle service - version safety (M, prompt §14)', () => {
  it('throws a conflict when a concurrent write lands between read and update', async () => {
    const env = createLifecycleEnv();
    const racing = new RacingRepository(env.repository);
    const racingService = createMemoryLifecycleService({
      repository: racing,
      lifecycle: env.lifecycle,
      retention: new DefaultMemoryRetentionEvaluator(),
      accessPolicy: env.accessPolicy,
      config: env.config,
      clock: env.clock,
      events: env.events,
    });
    await env.repository.save(expiredConversation());
    await expect(
      racingService.run({
        actor: memoryManagerActor,
        namespace: 'user:1',
        key: 'k_conv',
        reason: 'sweep',
      }),
    ).rejects.toThrow(MemoryConflictError);
  });

  it('bumps the version exactly once per transition', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation());
    const outcome = await lifecycleService.run({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
      reason: 'sweep',
    });
    expect(outcome.record?.version).toBe(2);
  });
});

describe('Lifecycle service - authorization (N, prompt §15)', () => {
  it('rejects evaluate when the actor lacks delete-class permission', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation());
    await expect(
      lifecycleService.evaluate({
        actor: clientActor,
        namespace: 'user:1',
        key: 'k_conv',
      }),
    ).rejects.toThrow(MemoryAccessDeniedError);
  });

  it('rejects run when the actor lacks delete-class permission', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation());
    await expect(
      lifecycleService.run({
        actor: clientActor,
        namespace: 'user:1',
        key: 'k_conv',
        reason: 'sweep',
      }),
    ).rejects.toThrow(MemoryAccessDeniedError);
  });

  it('fails closed when AG-002 lacks delete permission on the record type', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(
      makeRecord({
        key: 'k_user',
        type: MemoryType.User,
        retention: { kind: 'until_deletion' },
        expiresAt: PAST,
      }),
    );
    await expect(
      lifecycleService.run({
        actor: memoryManagerActor,
        namespace: 'user:1',
        key: 'k_user',
        reason: 'sweep',
      }),
    ).rejects.toThrow(MemoryAccessDeniedError);
  });

  it('includes type, namespace and security level in the denial details', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation());
    try {
      await lifecycleService.run({
        actor: clientActor,
        namespace: 'user:1',
        key: 'k_conv',
        reason: 'sweep',
      });
      expect.unreachable();
    } catch (error) {
      const typed = error as MemoryAccessDeniedError;
      expect(typed.details).toMatchObject({
        namespace: 'user:1',
        key: 'k_conv',
        type: MemoryType.Conversation,
      });
    }
  });
});

describe('Lifecycle service - immutability (O, prompt §16)', () => {
  it('does not mutate the record during evaluate', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation());
    await lifecycleService.evaluate({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
    });
    const stored = await repository.get('user:1', 'k_conv');
    expect(stored?.lifecycle).toBe(S.Active);
    expect(stored?.version).toBe(1);
  });

  it('returns a distinct record object after run', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation());
    const before = await repository.get('user:1', 'k_conv');
    const outcome = await lifecycleService.run({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k_conv',
      reason: 'sweep',
    });
    expect(outcome.record).not.toBe(before);
  });
});

describe('Lifecycle service - configuration (P, prompt §17)', () => {
  it('fails closed when lifecycle evaluation is disabled', async () => {
    const config = MemoryConfigSchema.parse({ MEMORY_LIFECYCLE_EVALUATION_ENABLED: 'false' });
    const { repository, lifecycleService } = createLifecycleEnv({ config });
    await repository.save(expiredConversation());
    await expect(
      lifecycleService.evaluate({ actor: memoryManagerActor, namespace: 'user:1', key: 'k_conv' }),
    ).rejects.toThrow(MemoryConfigurationError);
    await expect(
      lifecycleService.run({
        actor: memoryManagerActor,
        namespace: 'user:1',
        key: 'k_conv',
        reason: 'sweep',
      }),
    ).rejects.toThrow(MemoryConfigurationError);
  });

  it('rejects an out-of-range batch limit', async () => {
    const { lifecycleService } = createLifecycleEnv();
    await expect(
      lifecycleService.runBatch({ actor: memoryManagerActor, limit: 0 }),
    ).rejects.toThrow(MemoryConfigurationError);
  });

  it('uses the configured batch limit by default', async () => {
    const config = MemoryConfigSchema.parse({ MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT: '1' });
    const { repository, lifecycleService } = createLifecycleEnv({ config });
    await repository.save(expiredConversation({ key: 'k_a' }));
    await repository.save(expiredConversation({ key: 'k_b' }));
    const results = await lifecycleService.runBatch({ actor: memoryManagerActor });
    expect(results).toHaveLength(1);
    expect(results[0]?.record?.key).toBe('k_a');
  });
});

describe('Lifecycle service - runBatch (R, prompt §20)', () => {
  it('transitions a deterministic, sorted batch within actor scope', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation({ key: 'k_b' }));
    await repository.save(expiredConversation({ key: 'k_a' }));
    await repository.save(expiredConversation({ key: 'k_c' }));
    await repository.save(expiredConversation({ namespace: 'user:2', key: 'k_other' }));
    const results = await lifecycleService.runBatch({ actor: memoryManagerActor });
    expect(results.map((result) => result.record?.key)).toEqual(['k_a', 'k_b', 'k_c']);
  });

  it('honours an explicit candidate limit', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation({ key: 'k_a' }));
    await repository.save(expiredConversation({ key: 'k_b' }));
    await repository.save(expiredConversation({ key: 'k_c' }));
    const results = await lifecycleService.runBatch({ actor: memoryManagerActor, limit: 2 });
    expect(results.map((result) => result.record?.key)).toEqual(['k_a', 'k_b']);
  });

  it('confines the batch to a namespace when requested', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation({ key: 'k_a' }));
    await repository.save(expiredConversation({ namespace: 'project:1', key: 'k_p' }));
    const results = await lifecycleService.runBatch({
      actor: memoryManagerActor,
      namespace: 'project:1',
    });
    expect(results.map((result) => result.record?.key)).toEqual(['k_p']);
  });

  it('skips records the actor cannot reach and keeps no-op decisions', async () => {
    const { repository, lifecycleService } = createLifecycleEnv();
    await repository.save(expiredConversation({ key: 'k_a' }));
    await repository.save(expiredConversation({ key: 'k_b' }));
    const results = await lifecycleService.runBatch({
      actor: memoryManagerActor,
      namespace: 'user:2',
    });
    expect(results).toHaveLength(0);
  });
});
