import type pg from 'pg';
import { MemoryStorageError } from '../errors/index.js';

/**
 * Sprint 13 — PostgreSQL schema definition + deterministic migration mechanism.
 *
 * The schema is versioned through a `schema_migrations` table. Migrations run in
 * ascending version order inside transactions; each applied migration is
 * recorded so re-applying is a no-op. A clean database is brought to the latest
 * schema deterministically; an existing database is only advanced forward.
 *
 * This file carries NO credentials and never logs connection strings.
 */

export interface SchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** The ordered, deterministic migration set for AG-002 memory persistence. */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: 'initial-memory-store',
    sql: `
CREATE TABLE IF NOT EXISTS memory_records (
  id                TEXT        PRIMARY KEY,
  namespace         TEXT        NOT NULL,
  key               TEXT        NOT NULL,
  type              TEXT        NOT NULL,
  owner             JSONB       NOT NULL,
  content           JSONB       NOT NULL,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  priority          TEXT        NOT NULL,
  security_level    TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ,
  ttl_ms            BIGINT,
  retention         JSONB       NOT NULL,
  version           INTEGER     NOT NULL,
  lifecycle         TEXT        NOT NULL,
  reason            TEXT        NOT NULL,
  trace_id          TEXT        NOT NULL,
  source            JSONB,
  CONSTRAINT memory_namespace_key_unique UNIQUE (namespace, key),
  CONSTRAINT memory_id_lower_valid CHECK (id <> ''),
  CONSTRAINT memory_version_positive CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS memory_records_namespace_idx ON memory_records (namespace);
CREATE INDEX IF NOT EXISTS memory_records_lifecycle_idx ON memory_records (lifecycle);
CREATE INDEX IF NOT EXISTS memory_records_security_level_idx ON memory_records (security_level);
CREATE INDEX IF NOT EXISTS memory_records_created_at_idx ON memory_records (created_at);
CREATE INDEX IF NOT EXISTS memory_records_updated_at_idx ON memory_records (updated_at);

CREATE TABLE IF NOT EXISTS memory_events (
  event_id          TEXT        PRIMARY KEY,
  sequence          BIGINT      NOT NULL,
  type              TEXT        NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  trace_id          TEXT        NOT NULL,
  namespace         TEXT        NOT NULL,
  key               TEXT        NOT NULL,
  memory_id         TEXT,
  actor_group       TEXT,
  actor_id          TEXT,
  actor_type        TEXT,
  version           INTEGER,
  previous_version  INTEGER,
  previous_state    TEXT,
  new_state         TEXT,
  reason            TEXT,
  hard              BOOLEAN,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT memory_events_sequence_unique UNIQUE (sequence)
);
CREATE INDEX IF NOT EXISTS memory_events_namespace_idx ON memory_events (namespace);
CREATE INDEX IF NOT EXISTS memory_events_type_idx ON memory_events (type);
CREATE INDEX IF NOT EXISTS memory_events_occurred_at_idx ON memory_events (occurred_at);
`,
  },
  {
    version: 2,
    name: 'event-correlation-columns',
    sql: `
ALTER TABLE memory_events
  ADD COLUMN IF NOT EXISTS correlation_id  TEXT,
  ADD COLUMN IF NOT EXISTS request_id      TEXT,
  ADD COLUMN IF NOT EXISTS service         TEXT,
  ADD COLUMN IF NOT EXISTS severity        TEXT,
  ADD COLUMN IF NOT EXISTS category        TEXT,
  ADD COLUMN IF NOT EXISTS source          TEXT,
  ADD COLUMN IF NOT EXISTS event_type      TEXT;
`,
  },
];

/** Current schema version is the highest applied migration version. */
export const SCHEMA_VERSION: number = SCHEMA_MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

/** Returns a safe schema-version for an applied row (ignores malformed rows). */
function parseAppliedVersion(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isInteger(n)) {
      return n;
    }
  }
  return undefined;
}

/**
 * Runs all pending migrations against the given pool, deterministically and in
 * order. Idempotent across restart: already-applied versions are skipped.
 * Throws a typed {@link MemoryStorageError} if any migration fails (rolled back).
 */
export async function migrateSchema(pool: pg.Pool): Promise<number> {
  const client = await acquireClient(pool);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT   NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const appliedRes = await client.query<{ version: unknown }>(
      'SELECT version FROM schema_migrations',
    );
    const applied = new Set<number>();
    for (const row of appliedRes.rows) {
      const v = parseAppliedVersion(row.version);
      if (v !== undefined) {
        applied.add(v);
      }
    }

    let appliedCount = 0;
    for (const migration of [...SCHEMA_MIGRATIONS].sort((a, b) => a.version - b.version)) {
      if (applied.has(migration.version)) {
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          migration.version,
          migration.name,
        ]);
        await client.query('COMMIT');
        appliedCount += 1;
      } catch (cause) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MemoryStorageError(
          `Memory schema migration ${migration.version} (${migration.name}) failed`,
          {
            details: { version: migration.version, name: migration.name },
            cause,
          },
        );
      }
    }
    return appliedCount;
  } finally {
    client.release();
  }
}

/** Acquires a client from the pool, mapping connection failures to typed errors. */
export async function acquireClient(pool: pg.Pool): Promise<pg.PoolClient> {
  try {
    return await pool.connect();
  } catch (cause) {
    throw new MemoryStorageError('Unable to acquire a PostgreSQL connection', { cause });
  }
}

/** Number of pending (not-yet-applied) migrations. Uses a short-lived connection. */
export async function pendingMigrations(pool: pg.Pool): Promise<number> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return SCHEMA_MIGRATIONS.length;
  }
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT   NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const res = await client.query<{ version: unknown }>('SELECT version FROM schema_migrations');
    const applied = new Set<number>();
    for (const row of res.rows) {
      const v = parseAppliedVersion(row.version);
      if (v !== undefined) {
        applied.add(v);
      }
    }
    return SCHEMA_MIGRATIONS.filter((m) => !applied.has(m.version)).length;
  } finally {
    client.release();
  }
}
