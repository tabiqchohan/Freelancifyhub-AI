import { describe, expect, it } from 'vitest';

import {
  FixedClock,
  InMemoryEventLog,
  MemoryEventType,
  MemoryOwnerKind,
  MemoryType,
  createEventLog,
  createEventLogRecorder,
  createMemoryConsolidationService,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import { createTestEnv, clientActor, memoryManagerActor } from './fixtures.js';

import type { MemoryLifecycleState } from '../../../../src/agents/ag-002-memory-manager/index.js';
import type { MemoryJsonValue } from '../../../../src/agents/ag-002-memory-manager/index.js';
import type { MemoryEvent } from '../../../../src/agents/ag-002-memory-manager/events/index.js';

// ---------------------------------------------------------------- helpers

const T0 = '2026-01-01T00:00:00.000Z';

function makeIdFactory(): () => string {
  let n = 0;
  return () => `evt_${String(++n).padStart(4, '0')}`;
}

function validEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    type: MemoryEventType.Created,
    traceId: 'trace_1',
    occurredAt: T0,
    namespace: 'user:1',
    key: 'theme',
    ...overrides,
  };
}

function makeLog(overrides: { stepMs?: number; sanitize?: boolean; maxPageSize?: number } = {}) {
  return new InMemoryEventLog({
    clock: new FixedClock(T0, overrides.stepMs ?? 0),
    eventIdFactory: makeIdFactory(),
    sanitize: overrides.sanitize ?? true,
    maxPageSize: overrides.maxPageSize ?? 50,
    maxBatchSize: 100,
  });
}

// --------------------------------------------------------------------- A–F
describe('Sprint 7 - Event model & validation (A–F)', () => {
  it('A: creates canonical stored events with stable metadata', () => {
    const log = makeLog();
    const stored = log.append(validEvent({ type: MemoryEventType.Created, version: 1 }));
    expect(stored.eventId).toBe('evt_0001');
    expect(stored.type).toBe(MemoryEventType.Created);
    expect(stored.eventType).toBe(MemoryEventType.Created);
    expect(stored.sequence).toBe(0);
    expect(stored.occurredAt).toBe(T0);
    expect(stored.timestamp).toBe(T0);
    expect(stored.severity).toBe('info');
    expect(stored.category).toBe('lifecycle');
  });

  it('B: validates events before hosting them', () => {
    const log = makeLog();
    expect(() => log.append(validEvent({ type: MemoryEventType.Created }))).not.toThrow();
  });

  it('C: requires core fields (type, timestamp, namespace, key)', () => {
    const log = makeLog();
    expect(() =>
      log.append({ ...validEvent(), type: undefined as unknown as MemoryEventType }),
    ).toThrow('malformed');
    expect(() => log.append({ ...validEvent(), occurredAt: 'not-a-timestamp' as never })).toThrow(
      'malformed',
    );
    expect(() => log.append({ ...validEvent(), namespace: '' })).toThrow('malformed');
    expect(() => log.append({ ...validEvent(), key: '' })).toThrow('malformed');
  });

  it('D: rejects malformed events (invalid timestamp, bad ids)', () => {
    const log = makeLog();
    expect(() => log.append({ ...validEvent(), occurredAt: 'garbage' as never })).toThrow(
      'malformed',
    );
    expect(() =>
      log.append({ ...validEvent(), eventId: 'bad id with spaces' } as MemoryEvent),
    ).toThrow('malformed');
  });

  it('E: rejects events with an invalid version (non-positive)', () => {
    const log = makeLog();
    expect(() => log.append({ ...validEvent(), version: 0 })).toThrow('malformed');
    expect(() => log.append({ ...validEvent(), version: -1 })).toThrow('malformed');
    expect(() => log.append({ ...validEvent(), version: 1.5 })).toThrow('malformed');
  });

  it('F: rejects events with an unknown lifecycle state', () => {
    const log = makeLog();
    expect(() =>
      log.append({ ...validEvent(), newState: 'NOT_A_STATE' as MemoryLifecycleState }),
    ).toThrow('malformed');
  });
});

// --------------------------------------------------------------------- G–M
describe('Sprint 7 - Event log fundamentals (G–M)', () => {
  it('G: appends single events in order', () => {
    const log = makeLog();
    log.append(validEvent({ type: MemoryEventType.Created }));
    log.append(validEvent({ type: MemoryEventType.Updated }));
    expect(log.count()).toBe(2);
    expect(log.latest(10).map((e) => e.sequence)).toEqual([1, 0]);
  });

  it('H: appends batches atomically', () => {
    const log = makeLog();
    const stored = log.appendBatch([
      validEvent({ type: MemoryEventType.Created }),
      validEvent({ type: MemoryEventType.Updated }),
      validEvent({ type: MemoryEventType.Deleted }),
    ]);
    expect(stored.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(log.count()).toBe(3);
  });

  it('H2: a malformed event in a batch rolls back the whole batch', () => {
    const log = makeLog();
    expect(() =>
      log.appendBatch([
        validEvent({ type: MemoryEventType.Created }),
        { ...validEvent(), occurredAt: 'bad' as never },
      ]),
    ).toThrow('malformed');
    expect(log.count()).toBe(0);
  });

  it('I: reads a stored event by id', () => {
    const log = makeLog();
    const stored = log.append(validEvent({ type: MemoryEventType.Archived, memoryId: 'memory_1' }));
    expect(log.getById(stored.eventId)?.type).toBe(MemoryEventType.Archived);
  });

  it('J: rejects duplicate event ids', () => {
    const log = makeLog();
    log.append(validEvent({ eventId: 'evt_dup' } as MemoryEvent));
    expect(() => log.append(validEvent({ eventId: 'evt_dup' } as MemoryEvent))).toThrow(
      'Duplicate event id',
    );
  });

  it('K: returns undefined for an unknown id (not found)', () => {
    const log = makeLog();
    expect(log.getById('evt_missing')).toBeUndefined();
  });

  it('L: is append-only (no update/delete mutation surface)', () => {
    const log = makeLog();
    expect(typeof (log as unknown as { update?: unknown }).update).toBe('undefined');
    expect(typeof (log as unknown as { delete?: unknown }).delete).toBe('undefined');
  });

  it('M: counts stored events with and without a filter', () => {
    const log = makeLog();
    log.append(validEvent({ type: MemoryEventType.Created, actorId: 'a' }));
    log.append(validEvent({ type: MemoryEventType.Updated, actorId: 'a' }));
    log.append(validEvent({ type: MemoryEventType.Deleted, actorId: 'b' }));
    expect(log.count()).toBe(3);
    expect(log.count({ actorId: 'a' })).toBe(2);
  });
});

// --------------------------------------------------------------------- N–R
describe('Sprint 7 - Event immutability (N–R)', () => {
  it('N: rejects top-level mutation of a returned event', () => {
    const log = makeLog();
    const stored = log.append(validEvent({ type: MemoryEventType.Created }));
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as { reason?: string }).reason = 'hacked';
    }).toThrow();
    expect(log.getById(stored.eventId)?.reason).toBeUndefined();
  });

  it('O: rejects nested payload mutation', () => {
    const log = makeLog({ sanitize: false });
    const stored = log.append(validEvent({ metadata: { nested: { depth: 1 } } }));
    const meta = stored.metadata as Record<string, unknown>;
    expect(Object.isFrozen(meta)).toBe(true);
    expect(() => {
      (meta.nested as Record<string, unknown>).depth = 99;
    }).toThrow();
  });

  it('P: rejects metadata mutation', () => {
    const log = makeLog({ sanitize: false });
    const stored = log.append(validEvent({ metadata: { note: 'original' } }));
    expect(() => {
      (stored.metadata as Record<string, unknown>).note = 'changed';
    }).toThrow();
  });

  it('Q: rejects array mutation', () => {
    const log = makeLog();
    const stored = log.append(
      validEvent({ type: MemoryEventType.MemoryConsolidated, sourceIds: ['m1', 'm2'] }),
    );
    expect(Object.isFrozen(stored.sourceIds)).toBe(true);
    expect(() => {
      (stored.sourceIds as string[]).push('m3');
    }).toThrow();
  });

  it('R: returned query results are immutable snapshots', () => {
    const log = makeLog();
    log.append(validEvent({ type: MemoryEventType.Created }));
    const page = log.query({ maxPageSize: 10 });
    expect(Object.isFrozen(page.items[0])).toBe(true);
    expect(() => {
      (page.items[0] as { key?: string }).key = 'mutated';
    }).toThrow();
    // Store is unaffected.
    expect(log.getById(page.items[0]!.eventId)?.key).toBe('theme');
  });
});

// --------------------------------------------------------------------- S–V
describe('Sprint 7 - Deterministic ordering (S–V)', () => {
  it('S: orders by timestamp sequence (append order)', () => {
    const log = makeLog();
    log.append(
      validEvent({ type: MemoryEventType.Created, occurredAt: '2026-01-01T00:00:01.000Z' }),
    );
    log.append(
      validEvent({ type: MemoryEventType.Created, occurredAt: '2026-01-01T00:00:00.000Z' }),
    );
    const events = log.query({ maxPageSize: 10 }).items;
    expect(events[0]!.occurredAt).toBe('2026-01-01T00:00:01.000Z');
    expect(events[1]!.occurredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('T: uses the sequence as the primary stable ordering key', () => {
    const log = makeLog();
    const a = log.append(validEvent({ eventId: 'evt_a' } as MemoryEvent));
    const b = log.append(validEvent({ eventId: 'evt_b' } as MemoryEvent));
    const c = log.append(validEvent({ eventId: 'evt_c' } as MemoryEvent));
    // Ordered by append sequence, not id.
    expect(log.query({ maxPageSize: 10 }).items.map((e) => e.eventId)).toEqual([
      a.eventId,
      b.eventId,
      c.eventId,
    ]);
  });

  it('U: events sharing an equal timestamp stay in append order (sequence tiebreak)', () => {
    const log = makeLog();
    log.append(validEvent({ eventId: 'evt_early' } as MemoryEvent));
    log.append(validEvent({ eventId: 'evt_late' } as MemoryEvent));
    const events = log.query({ maxPageSize: 10 }).items;
    // Same timestamp here (T0); sequence preserves order.
    expect(events[0]!.eventId).toBe('evt_early');
    expect(events[1]!.eventId).toBe('evt_late');
  });

  it('V: repeated queries return the same deterministic order', () => {
    const log = makeLog();
    for (let i = 0; i < 5; i += 1) {
      log.append(
        validEvent({ type: MemoryEventType.Created, occurredAt: `2026-01-01T00:00:0${i}.000Z` }),
      );
    }
    const first = log.query({ maxPageSize: 10 }).items.map((e) => e.eventId);
    const second = log.query({ maxPageSize: 10 }).items.map((e) => e.eventId);
    expect(second).toEqual(first);
  });
});

// --------------------------------------------------------------------- W–AE
describe('Sprint 7 - Event query filters (W–AE)', () => {
  const seed = (log: InMemoryEventLog) => {
    log.append(
      validEvent({
        type: MemoryEventType.Created,
        memoryId: 'mem_1',
        actorId: 'alice',
        organizationId: 'orgX',
        workspaceId: 'wsX',
        projectId: 'projX',
        correlationId: 'corr_1',
        requestId: 'req_1',
        severity: 'info',
        category: 'lifecycle',
        occurredAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    log.append(
      validEvent({
        type: MemoryEventType.AccessDenied,
        memoryId: 'mem_2',
        actorId: 'bob',
        organizationId: 'orgY',
        workspaceId: 'wsY',
        projectId: 'projY',
        correlationId: 'corr_2',
        requestId: 'req_2',
        severity: 'warning',
        category: 'security',
        occurredAt: '2026-01-02T00:00:00.000Z',
      }),
    );
  };

  it('W: filters by eventType', () => {
    const log = makeLog();
    seed(log);
    expect(log.query({ type: MemoryEventType.Created, maxPageSize: 10 }).items).toHaveLength(1);
  });

  it('X: filters by memoryId', () => {
    const log = makeLog();
    seed(log);
    expect(log.query({ memoryId: 'mem_2', maxPageSize: 10 }).items).toHaveLength(1);
  });

  it('Y: filters by actorId', () => {
    const log = makeLog();
    seed(log);
    expect(log.query({ actorId: 'alice', maxPageSize: 10 }).items).toHaveLength(1);
  });

  it('Z: filters by organization', () => {
    const log = makeLog();
    seed(log);
    expect(log.query({ organizationId: 'orgX', maxPageSize: 10 }).items).toHaveLength(1);
  });

  it('AA: filters by workspace', () => {
    const log = makeLog();
    seed(log);
    expect(log.query({ workspaceId: 'wsY', maxPageSize: 10 }).items).toHaveLength(1);
  });

  it('AB: filters by project', () => {
    const log = makeLog();
    seed(log);
    expect(log.query({ projectId: 'projX', maxPageSize: 10 }).items).toHaveLength(1);
  });

  it('AC: filters by correlationId', () => {
    const log = makeLog();
    seed(log);
    expect(log.query({ correlationId: 'corr_2', maxPageSize: 10 }).items).toHaveLength(1);
  });

  it('AD: filters by timestamp range', () => {
    const log = makeLog();
    seed(log);
    const page = log.query({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-01T23:59:59.999Z',
      maxPageSize: 10,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.actorId).toBe('alice');
  });

  it('AE: combines filters', () => {
    const log = makeLog();
    seed(log);
    const page = log.query({
      organizationId: 'orgX',
      category: 'lifecycle',
      severity: 'info',
      maxPageSize: 10,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.memoryId).toBe('mem_1');
  });
});

// --------------------------------------------------------------------- AF–AL
describe('Sprint 7 - Cursor pagination (AF–AL)', () => {
  function seedN(log: InMemoryEventLog, n: number) {
    for (let i = 0; i < n; i += 1) {
      log.append(validEvent({ type: MemoryEventType.Created }));
    }
  }

  it('AF: returns the first page', () => {
    const log = makeLog({ maxPageSize: 10 });
    seedN(log, 25);
    const page = log.query({ maxPageSize: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.total).toBe(25);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeDefined();
  });

  it('AG: follows the cursor to the next page', () => {
    const log = makeLog({ maxPageSize: 10 });
    seedN(log, 25);
    const first = log.query({ maxPageSize: 10 });
    const second = log.query({ maxPageSize: 10, cursor: first.nextCursor });
    expect(second.items).toHaveLength(10);
    expect(second.items[0]!.sequence).toBe(10);
    expect(second.nextCursor).toBeDefined();
  });

  it('AH: fails closed on an invalid cursor', () => {
    const log = makeLog();
    seedN(log, 5);
    expect(() => log.query({ maxPageSize: 10, cursor: '!!!not-a-cursor!!!' })).toThrow('cursor');
    expect(() => log.query({ maxPageSize: 10, cursor: 'bm90LXN0cnVjdHVyZWQ=' })).toThrow('cursor');
  });

  it('AI: validates the page limit', () => {
    const log = makeLog({ maxPageSize: 10 });
    expect(() => log.query({ maxPageSize: 10, limit: 0 })).toThrow('positive');
    expect(() => log.query({ maxPageSize: 10, limit: -1 })).toThrow('positive');
  });

  it('AJ: enforces the configured maximum limit', () => {
    const log = makeLog({ maxPageSize: 10 });
    expect(() => log.query({ maxPageSize: 10, limit: 11 })).toThrow('exceeds');
  });

  it('AK: never returns duplicate events across pages', () => {
    const log = makeLog({ maxPageSize: 8 });
    seedN(log, 25);
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = log.query({ maxPageSize: 8, cursor });
      const ids = page.items.map((e) => e.eventId);
      for (const id of ids) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      if (!page.hasMore || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(25);
  });

  it('AL: never misses events across pages (all present exactly once)', () => {
    const log = makeLog({ maxPageSize: 8 });
    seedN(log, 25);
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = log.query({ maxPageSize: 8, cursor });
      for (const e of page.items) seen.add(e.eventId);
      if (!page.hasMore || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(25);
  });
});

// --------------------------------------------------------------------- AM–AU
describe('Sprint 7 - Security sanitization (AM–AU)', () => {
  it('AM: redacts apiKey', () => {
    const log = makeLog();
    const stored = log.append(validEvent({ metadata: { apiKey: 'sk-live-abc' } }));
    expect((stored.metadata as Record<string, unknown>).apiKey).toBe('[REDACTED]');
  });

  it('AN: redacts password', () => {
    const log = makeLog();
    const stored = log.append(validEvent({ metadata: { password: 'hunter2' } }));
    expect((stored.metadata as Record<string, unknown>).password).toBe('[REDACTED]');
  });

  it('AO: redacts token', () => {
    const log = makeLog();
    const stored = log.append(validEvent({ metadata: { token: 'tok-xyz' } }));
    expect((stored.metadata as Record<string, unknown>).token).toBe('[REDACTED]');
  });

  it('AP: redacts secret', () => {
    const log = makeLog();
    const stored = log.append(validEvent({ metadata: { secret: 's3cr3t' } }));
    expect((stored.metadata as Record<string, unknown>).secret).toBe('[REDACTED]');
  });

  it('AQ: redacts credential', () => {
    const log = makeLog();
    const stored = log.append(validEvent({ metadata: { credential: 'cred' } }));
    expect((stored.metadata as Record<string, unknown>).credential).toBe('[REDACTED]');
  });

  it('AR: redacts pwd / passphrase', () => {
    const log = makeLog();
    expect(
      (log.append(validEvent({ metadata: { pwd: 'x' } })).metadata as Record<string, unknown>).pwd,
    ).toBe('[REDACTED]');
    expect(
      (
        log.append(validEvent({ metadata: { passphrase: 'y' } })).metadata as Record<
          string,
          unknown
        >
      ).passphrase,
    ).toBe('[REDACTED]');
  });

  it('AS: redacts nested secrets recursively', () => {
    const log = makeLog();
    const stored = log.append(
      validEvent({ metadata: { outer: { inner: { apiKey: 'sk-nested', ok: 1 }, ok: 2 } } }),
    );
    const outer = stored.metadata as {
      outer: { inner: { apiKey: string; ok: number }; ok: number };
    };
    expect(outer.outer.inner.apiKey).toBe('[REDACTED]');
    expect(outer.outer.inner.ok).toBe(1);
    expect(outer.outer.ok).toBe(2);
  });

  it('AT: redacts mixed-case and underscore key variants', () => {
    const log = makeLog();
    const stored = log.append(
      validEvent({ metadata: { ApiKey: 'a', api_key: 'b', CLIENT_SECRET: 'c' } }),
    );
    const meta = stored.metadata as Record<string, unknown>;
    expect(meta.ApiKey).toBe('[REDACTED]');
    expect(meta.api_key).toBe('[REDACTED]');
    expect(meta.CLIENT_SECRET).toBe('[REDACTED]');
  });

  it('AU: sanitization is non-mutating', () => {
    const source: Record<string, MemoryJsonValue> = {
      apiKey: 'sk-live',
      safe: { keep: 'fine' },
    };
    const original = JSON.stringify(source);
    const log = makeLog();
    log.append(validEvent({ metadata: source }));
    expect(JSON.stringify(source)).toBe(original);
  });

  it('AU2: values matching the secret heuristic are redacted', () => {
    const log = makeLog();
    const stored = log.append(validEvent({ metadata: { note: 'bearer 12345' } }));
    expect((stored.metadata as Record<string, unknown>).note).toBe('[REDACTED]');
  });

  it('metrics report sanitization count', () => {
    const log = makeLog();
    log.append(validEvent({ metadata: { apiKey: 'sk-1' } }));
    log.append(validEvent({ metadata: { ok: 'fine' } }));
    expect(log.metrics().sanitized).toBe(1);
  });
});

// --------------------------------------------------------------------- AV–BD
describe('Sprint 7 - Integration with memory services (AV–BD)', () => {
  function wiredLog() {
    const env = createTestEnv();
    const log = createEventLog();
    const recorder = createEventLogRecorder(log);
    env.events.on(recorder);
    return { env, log };
  }

  it('AV: lifecycle creation event flows into the log', async () => {
    const { env, log } = wiredLog();
    await env.service.createMemory({
      actor: clientActor,
      namespace: 'user:1',
      key: 'k1',
      type: MemoryType.Conversation,
      owner: { kind: MemoryOwnerKind.User, id: '1' },
      content: { text: 'hi' },
      reason: 'test',
    });
    const created = log.query({ type: MemoryEventType.Created, maxPageSize: 10 }).items;
    expect(created.length).toBeGreaterThan(0);
    expect(created[0]!.category).toBe('lifecycle');
  });

  it('AW: lifecycle and security events are captured truthfully', async () => {
    const { env, log } = wiredLog();
    await env.service.createMemory({
      actor: clientActor,
      namespace: 'user:1',
      key: 'k2',
      type: MemoryType.Conversation,
      owner: { kind: MemoryOwnerKind.User, id: '1' },
      content: { text: 'hi' },
      reason: 'test',
    });
    const types = log.latest(10).map((e) => e.type);
    expect(types).toContain(MemoryEventType.Created);
    expect(types).toContain(MemoryEventType.AccessAllowed);
  });

  it('AX: archival event is recorded', async () => {
    const { env, log } = wiredLog();
    const rec = await env.service.createMemory({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: 'k3',
      type: MemoryType.Conversation,
      owner: { kind: MemoryOwnerKind.User, id: '1' },
      content: { text: 'hi' },
      reason: 'test',
    });
    await env.service.archiveMemory({
      actor: memoryManagerActor,
      namespace: 'user:1',
      key: rec.key,
      reason: 'archive it',
    });
    expect(log.query({ type: MemoryEventType.Archived, maxPageSize: 10 }).items.length).toBe(1);
  });

  it('AZ: consolidation event is recorded', async () => {
    const { env, log } = wiredLog();
    await env.service.createMemory({
      actor: clientActor,
      namespace: 'user:1',
      key: 'grp-1',
      type: MemoryType.User,
      owner: { kind: MemoryOwnerKind.User, id: '1' },
      content: { text: 'one' },
      metadata: { consolidationGroup: 'g1' },
      reason: 'r',
    });
    await env.service.createMemory({
      actor: clientActor,
      namespace: 'user:1',
      key: 'grp-2',
      type: MemoryType.User,
      owner: { kind: MemoryOwnerKind.User, id: '1' },
      content: { text: 'two' },
      metadata: { consolidationGroup: 'g1' },
      reason: 'r',
    });
    const consolidation = createMemoryConsolidationService({
      repository: env.repository,
      events: env.events,
    });
    await consolidation.consolidate({
      actor: clientActor,
      namespace: 'user:1',
      reason: 'merge group',
    });
    expect(
      log.query({ type: MemoryEventType.MemoryConsolidated, maxPageSize: 10 }).items.length,
    ).toBe(1);
  });

  it('BA: access allowed event is recorded', async () => {
    const { env, log } = wiredLog();
    await env.service.createMemory({
      actor: clientActor,
      namespace: 'user:1',
      key: 'k4',
      type: MemoryType.Conversation,
      owner: { kind: MemoryOwnerKind.User, id: '1' },
      content: { text: 'x' },
      reason: 'test',
    });
    expect(log.count({ type: MemoryEventType.AccessAllowed })).toBeGreaterThan(0);
  });

  it('BB: a denied access emits AccessDenied and no false success event', async () => {
    const { env, log } = wiredLog();
    // memoryManager writes into a namespace the client cannot see.
    const rec = await env.service.createMemory({
      actor: memoryManagerActor,
      namespace: 'system:canonical',
      key: 'secret-k',
      type: MemoryType.Conversation,
      owner: { kind: MemoryOwnerKind.User, id: '1' },
      content: { text: 'secret' },
      reason: 'test',
    });
    // Client has no scope over system:canonical -> denied, no Retrieved.
    await expect(
      env.service.getMemory({
        actor: clientActor,
        namespace: 'system:canonical',
        key: rec.key,
      }),
    ).rejects.toThrow();
    expect(log.query({ type: MemoryEventType.AccessDenied, maxPageSize: 10 }).items.length).toBe(1);
    expect(
      log.query({ type: MemoryEventType.Retrieved, memoryId: rec.id, maxPageSize: 10 }).items,
    ).toHaveLength(0);
  });

  it('BC: a failed operation does not emit a false success event', async () => {
    const { env, log } = wiredLog();
    await env.service.createMemory({
      actor: clientActor,
      namespace: 'user:1',
      key: 'dup-k',
      type: MemoryType.Conversation,
      owner: { kind: MemoryOwnerKind.User, id: '1' },
      content: { text: 'hi' },
      reason: 'test',
    });
    // Duplicate key -> conflict; no second Created event may be emitted.
    await expect(
      env.service.createMemory({
        actor: clientActor,
        namespace: 'user:1',
        key: 'dup-k',
        type: MemoryType.Conversation,
        owner: { kind: MemoryOwnerKind.User, id: '1' },
        content: { text: 'hi' },
        reason: 'test',
      }),
    ).rejects.toThrow();
    expect(log.query({ type: MemoryEventType.Created, maxPageSize: 10 }).items).toHaveLength(1);
  });
});

// --------------------------------------------------------------------- BE–BH
describe('Sprint 7 - Correlation (BE–BH)', () => {
  it('BE/BF/BG/BH: correlation ids are queryable', () => {
    const log = makeLog();
    log.append(
      validEvent({
        type: MemoryEventType.Created,
        memoryId: 'mem_corr',
        requestId: 'req_x',
        correlationId: 'corr_x',
        traceId: 'trace_x',
        actorId: 'sam',
      }),
    );
    expect(log.query({ requestId: 'req_x', maxPageSize: 10 }).items).toHaveLength(1);
    expect(log.query({ correlationId: 'corr_x', maxPageSize: 10 }).items).toHaveLength(1);
    expect(log.query({ traceId: 'trace_x', maxPageSize: 10 }).items).toHaveLength(1);
    expect(log.query({ memoryId: 'mem_corr', maxPageSize: 10 }).items).toHaveLength(1);
  });
});

// --------------------------------------------------------------------- BI–BN
describe('Sprint 7 - Stress (BI–BN)', () => {
  it('BI: handles a large event set deterministically', () => {
    const log = makeLog({ maxPageSize: 100 });
    for (let i = 0; i < 2000; i += 1) {
      log.append(
        validEvent({
          type: MemoryEventType.Created,
          occurredAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        }),
      );
    }
    expect(log.count()).toBe(2000);
    const page = log.query({ maxPageSize: 100 });
    expect(page.total).toBe(2000);
    expect(page.items).toHaveLength(100);
  });

  it('BJ: handles large metadata without leaking it into metrics', () => {
    const log = makeLog();
    const bigMeta: Record<string, MemoryJsonValue> = {};
    for (let i = 0; i < 500; i += 1) {
      bigMeta[`k${i}`] = `value-${i}`;
    }
    log.append(validEvent({ metadata: bigMeta }));
    expect(log.metrics().appended).toBe(1);
    expect(JSON.stringify(log.metrics())).not.toContain('value-');
  });

  it('BK: sustains many queries', () => {
    const log = makeLog();
    for (let i = 0; i < 100; i += 1) {
      log.append(
        validEvent({ type: i % 2 === 0 ? MemoryEventType.Created : MemoryEventType.Updated }),
      );
    }
    for (let i = 0; i < 500; i += 1) {
      log.query({ type: MemoryEventType.Created, maxPageSize: 10 });
    }
    expect(log.metrics().queried).toBe(500);
  });

  it('BL: duplicate id stress is rejected without corrupting the log', () => {
    const log = makeLog();
    for (let i = 0; i < 50; i += 1) {
      log.append(validEvent({ type: MemoryEventType.Created }));
    }
    let rejected = 0;
    for (let i = 0; i < 50; i += 1) {
      try {
        log.append(validEvent({ eventId: 'evt_0001' } as MemoryEvent));
      } catch {
        rejected += 1;
      }
    }
    expect(rejected).toBe(50);
    expect(log.count()).toBe(50);
  });

  it('BM: concurrent appends keep a stable, gap-free sequence', async () => {
    const log = makeLog();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() => {
          log.append(validEvent({ type: MemoryEventType.Created }));
          return i;
        }),
      ),
    );
    expect(log.count()).toBe(20);
    const seq = log
      .latest()
      .map((e) => e.sequence)
      .sort((a, b) => a - b);
    expect(seq).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('BN: pagination stress walks a large set without gaps or duplicates', () => {
    const log = makeLog({ maxPageSize: 16 });
    for (let i = 0; i < 600; i += 1) {
      log.append(validEvent({ type: MemoryEventType.Created }));
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = log.query({ maxPageSize: 16, cursor });
      for (const e of page.items) seen.add(e.eventId);
      if (!page.hasMore || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
      guard += 1;
      expect(guard).toBeLessThan(100);
    }
    expect(seen.size).toBe(600);
  });
});
