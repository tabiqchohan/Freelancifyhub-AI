import { describe, it, expect } from 'vitest';
import {
  InMemoryEventLog,
  MemoryAccessDeniedError,
  MemoryActorGroup,
  MemoryConfigurationError,
  MemoryLifecycleTransitionError,
  MemoryEventType,
  MemoryLifecycleState,
  MemoryNotFoundError,
  MemoryOwnerKind,
  MemorySecurityLevel,
  MemoryType,
  createMemoryReplayService,
  replayMemoryStream,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import type {
  StoredMemoryEvent,
  MemoryConfig,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import {
  createTestConfig,
  createTestEnv,
  makeActor,
  makeCreateInput,
  makeOwner,
  memoryManagerActor,
  clientActor,
  adminActor,
} from './fixtures.js';

const S = MemoryLifecycleState;

function memoryConfigWith(partial: Partial<MemoryConfig>): MemoryConfig {
  return { ...createTestConfig(), ...partial };
}

let streamSeq = 0;
function ev(type: MemoryEventType, overrides: Partial<StoredMemoryEvent> = {}): StoredMemoryEvent {
  streamSeq += 1;
  const occurredAt = overrides.occurredAt ?? '2026-06-01T00:00:00.000Z';
  return {
    eventId: overrides.eventId ?? `evt_${streamSeq}`,
    type,
    eventType: type,
    occurredAt,
    timestamp: occurredAt,
    sequence: overrides.sequence ?? streamSeq,
    traceId: overrides.traceId ?? 'trace_replay',
    namespace: overrides.namespace ?? 'user:1',
    key: overrides.key ?? 'pref_theme',
    version: overrides.version,
    severity: overrides.severity ?? 'info',
    category: overrides.category ?? 'lifecycle',
    ...overrides,
  };
}

describe('Sprint 9 - restoreMemory', () => {
  it('moves an archived record back to ACTIVE and emits a Restored event', async () => {
    const { service, events } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    const archived = await service.archiveMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'retention archive',
    });
    expect(archived.lifecycle).toBe(S.Archived);

    const restored = await service.restoreMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'user requested restore',
    });
    expect(restored.lifecycle).toBe(S.Active);
    expect(restored.version).toBe((archived.version as number) + 1);
    const event = events.list().find((e) => e.type === MemoryEventType.Restored);
    expect(event).toBeDefined();
    expect(event?.previousVersion).toBe(archived.version);
  });

  it('denies restore to an actor without a delete-class privilege', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await service.archiveMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'archive',
    });
    await expect(
      service.restoreMemory({
        actor: clientActor,
        namespace: created.namespace,
        key: created.key,
        reason: 'try',
      }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });

  it('throws NotFound when the key does not exist', async () => {
    const { service } = createTestEnv();
    await expect(
      service.restoreMemory({
        actor: memoryManagerActor,
        namespace: 'user:1',
        key: 'missing',
        reason: 'restore',
      }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('throws NotFound for a Deleted memory (terminal; erase/delete not reconstructible)', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await service.deleteMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'remove',
    });
    await expect(
      service.restoreMemory({
        actor: memoryManagerActor,
        namespace: created.namespace,
        key: created.key,
        reason: 'restore',
      }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('throws NotFound for an erased memory (physically absent)', async () => {
    const { service, events } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await service.eraseMemoryById({
      actor: memoryManagerActor,
      memoryId: created.id,
      reason: 'dsr forget',
    });
    await expect(
      service.restoreMemory({
        actor: memoryManagerActor,
        namespace: created.namespace,
        key: created.key,
        reason: 'restore',
      }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
    expect(events.list().some((e) => e.type === MemoryEventType.Erased)).toBe(true);
  });

  it('is idempotent when the record is already ACTIVE (no version bump, no event)', async () => {
    const { service, events } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await events.clear();
    const active = await service.restoreMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'already active',
    });
    expect(active.lifecycle).toBe(S.Active);
    expect(active.version).toBe(created.version);
    expect(events.list().some((e) => e.type === MemoryEventType.Restored)).toBe(false);
  });

  it('denies restore for a namespace out of actor scope', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await service.archiveMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'archive',
    });
    const outsider = makeActor(MemoryActorGroup.MemoryManager, ['user:99']);
    await expect(
      service.restoreMemory({
        actor: outsider,
        namespace: created.namespace,
        key: created.key,
        reason: 'restore',
      }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });

  it('denies restore from an impossible lifecycle state', async () => {
    const { service, repository } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await repository.update(created.namespace, created.key, created.version, {
      ...created,
      lifecycle: S.Expired,
      version: created.version + 1,
    });
    await expect(
      service.restoreMemory({
        actor: memoryManagerActor,
        namespace: created.namespace,
        key: created.key,
        reason: 'restore',
      }),
    ).rejects.toBeInstanceOf(MemoryLifecycleTransitionError);
  });

  it('rejects an invalid reason', async () => {
    const { service } = createTestEnv();
    await expect(
      service.restoreMemory({
        actor: memoryManagerActor,
        namespace: 'user:1',
        key: 'x',
        reason: '',
      }),
    ).rejects.toThrow();
  });
});

describe('Sprint 9 - eraseMemoryById (DSR right-to-forget)', () => {
  it('physically removes the record and emits an Erased tombstone with no content', async () => {
    const { service, repository, events } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    const result = await service.eraseMemoryById({
      actor: memoryManagerActor,
      memoryId: created.id,
      reason: 'dsr forget',
    });
    expect(result).toEqual({ erased: 1, status: 'erased', scope: { id: created.id } });
    expect(await repository.getById(created.id)).toBeUndefined();

    const erasedEvent = events.list().find((e) => e.type === MemoryEventType.Erased);
    expect(erasedEvent).toBeDefined();
    expect(erasedEvent?.memoryId).toBe(created.id);
    expect(erasedEvent?.namespace).toBe(created.namespace);
    expect(erasedEvent?.key).toBe(created.key);
    expect(JSON.stringify(erasedEvent)).not.toContain('hello');
  });

  it('is idempotent when the record is already absent', async () => {
    const { service } = createTestEnv();
    const result = await service.eraseMemoryById({
      actor: memoryManagerActor,
      memoryId: 'memory_ghost_1',
      reason: 'dsr forget',
    });
    expect(result.erased).toBe(0);
    expect(result.status).toBe('erased');
  });

  it('denies erasure when the actor scope excludes the namespace (cross-tenant impossible)', async () => {
    const { service, repository } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    const outsider = makeActor(MemoryActorGroup.MemoryManager, ['user:99']);
    await expect(
      service.eraseMemoryById({ actor: outsider, memoryId: created.id, reason: 'forget' }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    expect(await repository.getById(created.id)).toBeDefined();
  });

  it('denies erasure when the actor lacks a Delete-class matrix permission', async () => {
    const { service, repository } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await expect(
      service.eraseMemoryById({ actor: clientActor, memoryId: created.id, reason: 'forget' }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    expect(await repository.getById(created.id)).toBeDefined();
  });

  it('fails closed when right-to-forget is disabled by configuration', async () => {
    const config = memoryConfigWith({ MEMORY_RIGHT_TO_FORGET_ENABLED: false });
    const { service } = createTestEnv({ config });
    const created = await service.createMemory(makeCreateInput());
    await expect(
      service.eraseMemoryById({ actor: adminActor, memoryId: created.id, reason: 'forget' }),
    ).rejects.toBeInstanceOf(MemoryConfigurationError);
  });

  it('denies erasure on a confidential record to a non-confidential actor', async () => {
    const { service, repository } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
        securityLevel: MemorySecurityLevel.Confidential,
      }),
    );
    const lowClearance = makeActor(MemoryActorGroup.Admin, ['user:1'], {
      securityClearance: MemorySecurityLevel.Internal,
      organizationId: '1',
    });
    await expect(
      service.eraseMemoryById({ actor: lowClearance, memoryId: created.id, reason: 'forget' }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    expect(await repository.getById(created.id)).toBeDefined();
  });

  it('emits an EraseDenied security event on unauthorized erasure', async () => {
    const { service, events } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    await expect(
      service.eraseMemoryById({ actor: clientActor, memoryId: created.id, reason: 'forget' }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    expect(events.list().some((e) => e.type === MemoryEventType.EraseDenied)).toBe(true);
  });
});

describe('Sprint 9 - eraseMemoryByNamespace (DSR right-to-forget)', () => {
  it('erases every record in the namespace and emits per-record tombstones', async () => {
    const { service, repository, events } = createTestEnv();
    await service.createMemory(makeCreateInput({ key: 'a', type: MemoryType.Conversation }));
    await service.createMemory(makeCreateInput({ key: 'b', type: MemoryType.Conversation }));
    const result = await service.eraseMemoryByNamespace({
      actor: memoryManagerActor,
      namespace: 'user:1',
      reason: 'dsr namespace forget',
    });
    expect(result.erased).toBe(2);
    const erasedEvents = events.list().filter((e) => e.type === MemoryEventType.Erased);
    expect(erasedEvents).toHaveLength(2);
    expect(await repository.count({ namespace: 'user:1' })).toBe(0);
  });

  it('denies erasure when the namespace is out of actor scope', async () => {
    const { service, repository } = createTestEnv();
    await service.createMemory(makeCreateInput({ key: 'a' }));
    const outsider = makeActor(MemoryActorGroup.MemoryManager, ['user:99']);
    await expect(
      service.eraseMemoryByNamespace({ actor: outsider, namespace: 'user:1', reason: 'forget' }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    expect(await repository.count({ namespace: 'user:1' })).toBe(1);
  });

  it('denies namespace erasure to a non-elevated actor group', async () => {
    const { service, repository } = createTestEnv();
    await service.createMemory(makeCreateInput({ key: 'a' }));
    await expect(
      service.eraseMemoryByNamespace({ actor: clientActor, namespace: 'user:1', reason: 'forget' }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    expect(await repository.count({ namespace: 'user:1' })).toBe(1);
  });

  it('fails closed when right-to-forget is disabled', async () => {
    const config = memoryConfigWith({ MEMORY_RIGHT_TO_FORGET_ENABLED: false });
    const { service } = createTestEnv({ config });
    await expect(
      service.eraseMemoryByNamespace({ actor: adminActor, namespace: 'user:1', reason: 'forget' }),
    ).rejects.toBeInstanceOf(MemoryConfigurationError);
  });

  it('emits an EraseDenied event when the actor scope excludes the namespace', async () => {
    const { service, events } = createTestEnv();
    const outsider = makeActor(MemoryActorGroup.MemoryManager, ['user:99']);
    await expect(
      service.eraseMemoryByNamespace({ actor: outsider, namespace: 'user:1', reason: 'forget' }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    expect(events.list().some((e) => e.type === MemoryEventType.EraseDenied)).toBe(true);
  });
});

describe('Sprint 9 - replayMemoryStream (pure, deterministic)', () => {
  it('returns empty state for an empty stream', () => {
    const result = replayMemoryStream([], { namespace: 'user:1', key: 'k' });
    expect(result.state).toBe('empty');
    expect(result.events).toEqual([]);
  });

  it('reconstructs active state from a single Created event', () => {
    const result = replayMemoryStream([ev(MemoryEventType.Created)], {
      namespace: 'user:1',
      key: 'pref_theme',
    });
    expect(result.state).toBe('active');
  });

  it('tracks the highest version across create->update', () => {
    const events = [
      ev(MemoryEventType.Created, { version: 1 }),
      ev(MemoryEventType.Updated, { version: 2 }),
    ];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    expect(result.state).toBe('active');
    expect(result.version).toBe(2);
  });

  it('reconstructs archived state from create->archive', () => {
    const events = [ev(MemoryEventType.Created), ev(MemoryEventType.Archived)];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    expect(result.state).toBe('archived');
  });

  it('reconstructs active state after create->archive->restore', () => {
    const events = [
      ev(MemoryEventType.Created),
      ev(MemoryEventType.Archived),
      ev(MemoryEventType.Restored, { version: 3 }),
    ];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    expect(result.state).toBe('active');
  });

  it('reconstructs deleted state from create->delete', () => {
    const events = [ev(MemoryEventType.Created), ev(MemoryEventType.Deleted)];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    expect(result.state).toBe('deleted');
  });

  it('reconstructs expired state from create->expired', () => {
    const events = [ev(MemoryEventType.Created), ev(MemoryEventType.Expired)];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    expect(result.state).toBe('expired');
  });

  it('rejects an impossible lifecycle transition as invalid', () => {
    const events = [
      ev(MemoryEventType.Created),
      ev(MemoryEventType.Deleted),
      ev(MemoryEventType.Archived),
    ];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    expect(result.state).toBe('invalid');
    expect(result.invalidReason).toBeDefined();
  });

  it('rejects an out-of-order (non-monotonic) sequence as invalid', () => {
    const a = ev(MemoryEventType.Created, { sequence: 1 });
    const b = ev(MemoryEventType.Updated, { sequence: 3 });
    const c = ev(MemoryEventType.Updated, { sequence: 2 });
    const result = replayMemoryStream([a, b, c], { namespace: 'user:1', key: 'pref_theme' });
    expect(result.state).toBe('invalid');
    expect(result.invalidReason).toContain('non-monotonic');
  });

  it('rejects duplicate event ids as invalid', () => {
    const first = ev(MemoryEventType.Created, { eventId: 'dup_id', sequence: 1 });
    const second = ev(MemoryEventType.Updated, { eventId: 'dup_id', sequence: 2 });
    const result = replayMemoryStream([first, second], { namespace: 'user:1', key: 'pref_theme' });
    expect(result.state).toBe('invalid');
    expect(result.invalidReason).toContain('duplicate');
  });

  it('honors the Erased tombstone and never reconstructs the memory as active', () => {
    const events = [ev(MemoryEventType.Created), ev(MemoryEventType.Erased, { version: 2 })];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    expect(result.state).toBe('erased');
  });

  it('returns erased even when the tombstone is the only event', () => {
    const result = replayMemoryStream([ev(MemoryEventType.Erased)], {
      namespace: 'user:1',
      key: 'pref_theme',
    });
    expect(result.state).toBe('erased');
  });

  it('stops at the tombstone and ignores events appended after erasure', () => {
    const events = [
      ev(MemoryEventType.Created),
      ev(MemoryEventType.Archived),
      ev(MemoryEventType.Erased),
      ev(MemoryEventType.Restored),
    ];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    expect(result.state).toBe('erased');
    expect(result.events.map((e) => e.type)).not.toContain(MemoryEventType.Restored);
  });

  it('is deterministic (same input yields identical output)', () => {
    const events = [ev(MemoryEventType.Created), ev(MemoryEventType.Updated, { version: 2 })];
    const a = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    const b = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    expect(a).toEqual(b);
  });

  it('is content-free: result events never carry the erased/secret payload', () => {
    const events = [
      ev(MemoryEventType.Created),
      ev(MemoryEventType.Updated, { version: 2 }),
      ev(MemoryEventType.Erased, { version: 3 }),
    ];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    for (const e of result.events) {
      expect(JSON.stringify(e)).not.toContain('secret');
    }
    expect(result.state).toBe('erased');
  });

  it('filters strictly to the target namespace and key (namespace isolation)', () => {
    const other = ev(MemoryEventType.Created, { namespace: 'user:99', key: 'z' });
    const target = ev(MemoryEventType.Created, { namespace: 'user:1', key: 'pref_theme' });
    const other2 = ev(MemoryEventType.Archived, { namespace: 'user:1', key: 'different' });
    const result = replayMemoryStream([other, target, other2], {
      namespace: 'user:1',
      key: 'pref_theme',
    });
    expect(result.state).toBe('active');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe(MemoryEventType.Created);
  });

  it('supports resuming replay from a prior snapshot state', () => {
    const events = [ev(MemoryEventType.Restored, { version: 3 })];
    const result = replayMemoryStream(events, {
      namespace: 'user:1',
      key: 'pref_theme',
      from: { state: 'archived', version: 2 },
    });
    expect(result.state).toBe('active');
    expect(result.version).toBe(3);
  });

  it('tracks the final event timestamp', () => {
    const events = [
      ev(MemoryEventType.Created, { occurredAt: '2026-06-01T00:00:00.000Z' }),
      ev(MemoryEventType.Updated, { occurredAt: '2026-06-02T00:00:00.000Z' }),
    ];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    expect(result.lastEventAt).toBe('2026-06-02T00:00:00.000Z');
  });

  it('returns a sanitized StoredMemoryEvent list as output (never MemoryRecord content)', () => {
    const events = [ev(MemoryEventType.Created, { version: 1 })];
    const result = replayMemoryStream(events, { namespace: 'user:1', key: 'pref_theme' });
    const first = result.events[0];
    expect(first).toBeDefined();
    expect((first as unknown as Record<string, unknown>).content).toBeUndefined();
  });

  it('does not leak a MemoryRecord into the replay output', () => {
    const result = replayMemoryStream([ev(MemoryEventType.Created)], {
      namespace: 'user:1',
      key: 'pref_theme',
    });
    expect(result).not.toHaveProperty('record');
    expect(result).not.toHaveProperty('content');
  });
});

describe('Sprint 9 - MemoryReplayService (over the event log)', () => {
  it('rejects replay when disabled by configuration', async () => {
    const config = memoryConfigWith({ MEMORY_EVENT_LOG_REPLAY_ENABLED: false });
    const replayService = createMemoryReplayService({ eventLog: new InMemoryEventLog(), config });
    await expect(replayService.replay({ namespace: 'user:1', key: 'k' })).rejects.toBeInstanceOf(
      MemoryConfigurationError,
    );
  });

  it('returns empty for an absent memory key', async () => {
    const log = new InMemoryEventLog();
    const replayService = createMemoryReplayService({ eventLog: log });
    const result = await replayService.replay({ namespace: 'user:1', key: 'ghost' });
    expect(result.state).toBe('empty');
  });

  it('reconstructs create->archive->restore over a real event log', async () => {
    const log = new InMemoryEventLog();
    const { service, events } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await service.archiveMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'archive',
    });
    await service.restoreMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'restore',
    });
    for (const event of events.list()) {
      log.append(event);
    }
    const replayService = createMemoryReplayService({ eventLog: log });
    const result = await replayService.replay({
      namespace: created.namespace,
      key: created.key,
    });
    expect(result.state).toBe('active');
  });

  it('reconstructs erased state over a real event log (no content leaked)', async () => {
    const log = new InMemoryEventLog();
    const { service, events } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await service.eraseMemoryById({
      actor: memoryManagerActor,
      memoryId: created.id,
      reason: 'dsr',
    });
    for (const event of events.list()) {
      log.append(event);
    }
    const replayService = createMemoryReplayService({ eventLog: log });
    const result = await replayService.replay({ namespace: created.namespace, key: created.key });
    expect(result.state).toBe('erased');
    expect(JSON.stringify(result.events)).not.toContain('hello');
  });

  it('replayNamespace returns one result per key in the namespace', async () => {
    const log = new InMemoryEventLog();
    const { service, events } = createTestEnv();
    await service.createMemory(makeCreateInput({ key: 'a', type: MemoryType.Conversation }));
    await service.createMemory(makeCreateInput({ key: 'b', type: MemoryType.Conversation }));
    for (const event of events.list()) {
      log.append(event);
    }
    const replayService = createMemoryReplayService({ eventLog: log });
    const results = await replayService.replayNamespace({ namespace: 'user:1' });
    const byKey = new Map(results.map((r) => [r.key, r.state]));
    expect(byKey.get('a')).toBe('active');
    expect(byKey.get('b')).toBe('active');
  });

  it('paginates through the log deterministically', async () => {
    const log = new InMemoryEventLog();
    for (let i = 0; i < 120; i += 1) {
      log.append({
        type: MemoryEventType.Created,
        traceId: 't',
        occurredAt: `2026-06-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        namespace: 'user:1',
        key: `k${i}`,
      });
    }
    const replayService = createMemoryReplayService({ eventLog: log });
    const results = await replayService.replayNamespace({ namespace: 'user:1' });
    expect(results).toHaveLength(120);
    expect(results.every((r) => r.state === 'active')).toBe(true);
  });

  it('validates the memory id/key namespace inputs', async () => {
    const log = new InMemoryEventLog();
    const replayService = createMemoryReplayService({ eventLog: log });
    await expect(replayService.replay({ namespace: '', key: 'k' })).rejects.toThrow();
  });
});

describe('Sprint 9 - orchestration restore wiring', () => {
  it('MUST NOT throw a deferred/unsupported error for restore (wired to real manager)', async () => {
    const { service, repository } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await service.archiveMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'archive',
    });
    const restored = await service.restoreMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'restore',
    });
    expect(restored.lifecycle).toBe(S.Active);
    expect(await repository.get(created.namespace, created.key)).toBeDefined();
  });
});
