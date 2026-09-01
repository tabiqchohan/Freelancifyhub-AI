import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryEventLog,
  MemoryConflictError,
  MemoryEventType,
  MemoryLifecycleState,
  MemoryPriority,
  SCHEMA_VERSION,
  PostgresEventSink,
  createPostgresAdapter,
  migrateSchema,
  pendingMigrations,
  PostgresMemoryRepository,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import type {
  MemoryEvent,
  PostgresStorageAdapter,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import { makeRecord } from '../../../unit/agents/ag-002-memory-manager/fixtures.js';

/**
 * Sprint 13 — real PostgreSQL (Neon) integration tests.
 *
 * These tests run ONLY when MEMORY_DATABASE_URL is configured (present in the
 * repo .env). They exercise the genuine PostgreSQL durable backend: schema
 * migrations, adapter CRUD, durable write + reload, repository semantics,
 * real transaction commit/rollback, and cross-connection restart durability.
 *
 * They are skipped in CI or any environment without a database URL, so the
 * committed suite never depends on a live network database.
 */

const DATABASE_URL = process.env.MEMORY_DATABASE_URL;

const suite = DATABASE_URL && DATABASE_URL.trim().length > 0 ? describe : describe.skip;

const ns = `int-postgres-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const T0 = '2026-01-01T00:00:00.000Z';
const EVENTS_NS = `${ns}-events`;

function validEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    type: MemoryEventType.Created,
    traceId: 'trace_pg',
    occurredAt: T0,
    namespace: EVENTS_NS,
    key: 'theme',
    ...overrides,
  };
}

suite(
  'Sprint 13 - real PostgreSQL backend (integration)',
  () => {
    let adapter: PostgresStorageAdapter;
    let repository: PostgresMemoryRepository;
    const closedAdapters: PostgresStorageAdapter[] = [];

    beforeAll(async () => {
      adapter = await createPostgresAdapter({ connection: DATABASE_URL! });
      // Apply migrations (idempotent) for the tested pool.
      await migrateSchema(adapter.poolForRepository);
      repository = new PostgresMemoryRepository(adapter);
    }, 120000);

    afterAll(async () => {
      await Promise.all(closedAdapters.map((a) => a.close().catch(() => undefined)));
      if (adapter) {
        await adapter.close().catch(() => undefined);
      }
    });

    async function cleanup(): Promise<void> {
      await repository.eraseByNamespace(ns);
    }

    describe('schema migrations', () => {
      it('are idempotent across repeated runs and reach the latest version', async () => {
        // The adapter's beforeAll already applies migrations, so a no-op re-run
        // returns 0 (idempotent) and no migrations remain pending.
        const rerun = await migrateSchema(adapter.poolForRepository);
        expect(rerun).toBe(0);
        expect(await pendingMigrations(adapter.poolForRepository)).toBe(0);
        expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
      });
    });

    describe('storage adapter (real PostgreSQL)', () => {
      it('is durable and declares durable capabilities', () => {
        expect(adapter.durable).toBe(true);
        expect(adapter.capabilities().capabilities).toContain('durable');
        expect(adapter.capabilities().supports?.('durable')).toBe(true);
      });

      it('writes, reads, reloads and removes records', async () => {
        const record = makeRecord({ namespace: ns, key: 'adapter-1' });
        await adapter.durableWrite(record);
        expect((await adapter.read(ns, 'adapter-1'))?.id).toBe(record.id);
        const reloaded = await adapter.reload(ns, 'adapter-1');
        expect(reloaded?.key).toBe('adapter-1');
        expect(await adapter.remove(ns, 'adapter-1')).toBe(true);
        expect(await adapter.read(ns, 'adapter-1')).toBeUndefined();
      });

      it('reports a live, healthy Postgres probe', async () => {
        const health = await adapter.healthAsync();
        expect(health.healthy).toBe(true);
        expect(health.checkedAt).toBeTruthy();
      });
    });

    describe('postgres repository semantics', () => {
      beforeEach(async () => {
        await cleanup();
      });
      afterEach(async () => {
        await cleanup();
      });

      it('create persists and get reads it back by namespace/key and id', async () => {
        const record = makeRecord({ namespace: ns, key: 'repo-1' });
        const created = await repository.create(record);
        expect(created.id).toBe(record.id);
        expect((await repository.get(ns, 'repo-1'))?.version).toBe(1);
        expect((await repository.getById(record.id))?.key).toBe('repo-1');
      });

      it('create conflicts on a live duplicate namespace/key', async () => {
        const record = makeRecord({ namespace: ns, key: 'repo-dup' });
        await repository.create(record);
        await expect(repository.create(record)).rejects.toBeInstanceOf(MemoryConflictError);
      });

      it('update is version-guarded (409 semantics)', async () => {
        const record = makeRecord({ namespace: ns, key: 'repo-ver' });
        await repository.create(record);
        const updated = { ...record, version: 2, content: { v: 2 } };
        const saved = await repository.update(ns, 'repo-ver', 1, updated);
        expect(saved.version).toBe(2);
        await expect(repository.update(ns, 'repo-ver', 1, updated)).rejects.toBeInstanceOf(
          MemoryConflictError,
        );
      });

      it('save upserts and delete physically removes', async () => {
        const record = makeRecord({ namespace: ns, key: 'repo-safe' });
        await repository.create(record);
        const bumped = { ...record, version: 3, lifecycle: MemoryLifecycleState.Deleted };
        const saved = await repository.save(bumped);
        expect(saved.lifecycle).toBe(MemoryLifecycleState.Deleted);
        expect(await repository.delete(ns, 'repo-safe')).toBe(true);
        expect(await repository.get(ns, 'repo-safe')).toBeUndefined();
      });

      it('query paginates deterministically with a cursor', async () => {
        await repository.create(
          makeRecord({ namespace: ns, key: 'q-a', priority: MemoryPriority.Low }),
        );
        await repository.create(
          makeRecord({ namespace: ns, key: 'q-b', priority: MemoryPriority.Medium }),
        );
        await repository.create(
          makeRecord({ namespace: ns, key: 'q-c', priority: MemoryPriority.High }),
        );
        const page1 = await repository.query({
          filter: { namespace: ns },
          sort: { field: 'key', direction: 'asc' },
          limit: 2,
          maxPageSize: 10,
        });
        expect(page1.items.map((r) => r.key)).toEqual(['q-a', 'q-b']);
        expect(page1.hasMore).toBe(true);
        expect(page1.nextCursor).toBeTruthy();
        const page2 = await repository.query({
          filter: { namespace: ns },
          sort: { field: 'key', direction: 'asc' },
          limit: 2,
          maxPageSize: 10,
          cursor: page1.nextCursor,
        });
        expect(page2.items.map((r) => r.key)).toEqual(['q-c']);
        expect(page2.hasMore).toBe(false);
      });
    });

    describe('real Postgres transactions', () => {
      beforeEach(async () => {
        await cleanup();
      });
      afterEach(async () => {
        await cleanup();
      });

      it('commits work atomically on success', async () => {
        const tx = adapter.transaction();
        await tx.run(async () => {
          await adapter.write(makeRecord({ namespace: ns, key: 'tx-ok' }));
          await adapter.write(makeRecord({ namespace: ns, key: 'tx-ok-2' }));
        });
        expect(await adapter.sizeAsync()).toBeGreaterThanOrEqual(2);
      });

      it('rolls back every write when work throws', async () => {
        await adapter.write(makeRecord({ namespace: ns, key: 'tx-outside' }));
        const tx = adapter.transaction();
        await expect(
          tx.run(async () => {
            await adapter.write(makeRecord({ namespace: ns, key: 'tx-a' }));
            await adapter.write(makeRecord({ namespace: ns, key: 'tx-b' }));
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect(await adapter.read(ns, 'tx-a')).toBeUndefined();
        expect(await adapter.read(ns, 'tx-b')).toBeUndefined();
        expect(await adapter.read(ns, 'tx-outside')).toBeDefined();
      });
    });

    describe('restart durability', () => {
      it('persists across an entirely fresh connection (survives process restart)', async () => {
        const record = makeRecord({
          id: `restart-${ns}-1`,
          namespace: ns,
          key: 'restart-1',
          content: { durable: true },
        });
        await repository.create(record);

        // Simulate a brand-new process: a new pool + adapter + repository.
        const restarted = await createPostgresAdapter({ connection: DATABASE_URL! });
        closedAdapters.push(restarted);
        const restartedRepo = new PostgresMemoryRepository(restarted);

        const read = await restartedRepo.get(ns, 'restart-1');
        expect(read).toBeDefined();
        expect(read!.content).toEqual({ durable: true });
        expect(read!.version).toBe(1);
      });
    });

    describe('durable event sink (Phase 13)', () => {
      function makeSink(): PostgresEventSink {
        return new PostgresEventSink(adapter.poolForRepository, new InMemoryEventLog());
      }

      it('canonically persists events to PostgreSQL and reads them back', async () => {
        const sink = makeSink();
        const stored = await sink.persist(
          validEvent({ eventId: `evt-${ns}-1`, type: MemoryEventType.Created }),
        );
        expect(stored.eventId).toBe(`evt-${ns}-1`);
        const fromPg = await sink.getById(`evt-${ns}-1`);
        expect(fromPg).toBeDefined();
        expect(fromPg!.namespace).toBe(EVENTS_NS);
        expect(fromPg!.type).toBe(MemoryEventType.Created);
      });

      it('survives process restart (events remain durable in PostgreSQL)', async () => {
        // First process persists events.
        const sink = makeSink();
        await sink.persist(
          validEvent({ eventId: `evt-restart-${ns}-1`, type: MemoryEventType.Updated }),
        );
        await sink.persist(
          validEvent({
            eventId: `evt-restart-${ns}-2`,
            type: MemoryEventType.Deleted,
            namespace: EVENTS_NS,
          }),
        );

        // A brand-new process reads the durable events back from PostgreSQL.
        const restartedSink = new PostgresEventSink(
          adapter.poolForRepository,
          new InMemoryEventLog(),
        );
        const read = await restartedSink.readByNamespace(EVENTS_NS);
        const ids = read.map((e) => e.eventId);
        expect(ids).toContain(`evt-restart-${ns}-1`);
        expect(ids).toContain(`evt-restart-${ns}-2`);
        expect(await restartedSink.count()).toBeGreaterThanOrEqual(2);
      });

      it('sanitizes secret-bearing metadata before persistence', async () => {
        const sink = makeSink();
        await sink.persist(
          validEvent({
            eventId: `evt-secret-${ns}-1`,
            metadata: { password: 'hunter2', apiKey: 'sk-secret', safe: 'fine' } as never,
          }),
        );
        const fromPg = await sink.getById(`evt-secret-${ns}-1`);
        const metadata = (fromPg!.metadata ?? {}) as Record<string, unknown>;
        expect(metadata.safe).toBe('fine');
        expect(metadata.password).toBe('[REDACTED]');
        expect(metadata.apiKey).toBe('[REDACTED]');
        expect(JSON.stringify(fromPg!.metadata)).not.toContain('hunter2');
        expect(JSON.stringify(fromPg!.metadata)).not.toContain('sk-secret');
      });
    });
  },
  90000,
);
