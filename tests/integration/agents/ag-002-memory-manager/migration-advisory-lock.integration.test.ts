/**
 * Prompts15 Phase 7 - shared PostgreSQL advisory-lock regression coverage.
 *
 * Sprint 36 found a clean-database migration race: concurrent
 * `CREATE TABLE ... IF NOT EXISTS` statements can still collide on the
 * PostgreSQL catalog (`duplicate key value violates unique constraint
 * "pg_type_typname_nsp_index"`). The fix serialises migrations behind one
 * advisory-lock key.
 *
 * AG-002, AG-003 and AG-004 all record into the SAME `schema_migrations` table,
 * so all three migrators MUST use the identical key. This suite pins that
 * contract, because a diverging key would silently reintroduce the race across
 * subsystems while each subsystem's own tests kept passing.
 *
 * Guarded (prompts13 Blocker 2): runs only against an isolated local test
 * database and never falls back to the production `MEMORY_DATABASE_URL`.
 */

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTestDatabase } from '../../../../src/lib/test-database-guard.js';
import {
  SCHEMA_MIGRATION_LOCK_KEY,
  SCHEMA_MIGRATIONS,
  migrateSchema,
} from '../../../../src/agents/ag-002-memory-manager/storage/schema.js';
import { migrateKnowledgeSchema } from '../../../../src/agents/ag-003-knowledge-manager/storage/schema.js';
import { migrateToolSchema } from '../../../../src/agents/ag-004-tool-manager/storage/schema.js';

const testDb = resolveTestDatabase('AG-002/003/004 shared advisory-lock integration suite');
const DATABASE_URL = testDb.url;

const suite = testDb.enabled ? describe : describe.skip;

suite('shared migration advisory lock (integration)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL!, max: 10 });
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  }, 30_000);

  it('all three migrators share one lock key', async () => {
    // The key is exported from AG-002 and imported by AG-003 and AG-004, so the
    // identity assertion here is what actually pins the cross-subsystem
    // contract at the integration boundary.
    expect(SCHEMA_MIGRATION_LOCK_KEY).toBe(8021976134501);

    // Every migrator must have applied its versions into the one shared
    // `schema_migrations` table, proving they coordinate rather than collide.
    await migrateSchema(pool);
    await migrateKnowledgeSchema(pool);
    await migrateToolSchema(pool);

    const res = await pool.query<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    );
    const versions = res.rows.map((r) => Number(r.version));

    for (const m of SCHEMA_MIGRATIONS) {
      expect(versions).toContain(m.version);
    }
  }, 120_000);

  it('blocks a competing session while held, and releases afterwards', async () => {
    // The behaviour that actually prevents the catalog collision: while one
    // session holds the migration lock, a DIFFERENT session must not be able to
    // acquire it; once released, it must be freely acquirable again.
    //
    // Session-scoped `pg_advisory_lock` is re-entrant for the same session, so
    // contention must be probed from a separate connection.
    const holder = new pg.Client({ connectionString: DATABASE_URL! });
    const contender = new pg.Client({ connectionString: DATABASE_URL! });
    try {
      await holder.connect();
      await contender.connect();

      await holder.query('SELECT pg_advisory_lock($1::bigint)', [SCHEMA_MIGRATION_LOCK_KEY]);

      // Different session: try_advisory_lock must fail while the holder holds it.
      const blocked = await contender.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [SCHEMA_MIGRATION_LOCK_KEY],
      );
      expect(blocked.rows[0]?.acquired).toBe(false);

      // Holder releases -> contender can now take it.
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [SCHEMA_MIGRATION_LOCK_KEY]);
      const free = await contender.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [SCHEMA_MIGRATION_LOCK_KEY],
      );
      expect(free.rows[0]?.acquired).toBe(true);
      await contender.query('SELECT pg_advisory_unlock($1::bigint)', [SCHEMA_MIGRATION_LOCK_KEY]);
    } finally {
      await holder.end().catch(() => undefined);
      await contender.end().catch(() => undefined);
    }
  }, 60_000);

  it('is idempotent: re-running every migrator applies nothing new', async () => {
    const first = await migrateSchema(pool);
    const second = await migrateSchema(pool);
    expect(second).toBe(0);
    // `first` may be >0 only on a cold database; it must never be negative and
    // a second run must be a strict no-op.
    expect(first).toBeGreaterThanOrEqual(0);

    const knowledgeSecond = await migrateKnowledgeSchema(pool);
    expect(knowledgeSecond).toBe(0);

    const toolsSecond = await migrateToolSchema(pool);
    expect(toolsSecond).toBe(0);
  }, 120_000);

  it('runs concurrent migrators without a catalog collision', async () => {
    // The regression itself: several processes migrating the same database at
    // same time must serialise rather than race on pg_type.
    const results = await Promise.allSettled([
      migrateSchema(pool),
      migrateKnowledgeSchema(pool),
      migrateToolSchema(pool),
      migrateSchema(pool),
    ]);

    for (const r of results) {
      if (r.status === 'rejected') {
        // Only the advisory lock (or a genuine SQL error) may surface; the
        // specific catalog violation this suite guards against must not.
        const message = String((r.reason as Error)?.message ?? '');
        expect(message).not.toContain('pg_type_typname_nsp_index');
        throw r.reason;
      }
    }
  }, 180_000);
});
