import type pg from 'pg';
import { ToolStorageError } from '../errors/index.js';

/**
 * AG-004 Tool Manager schema migrations. Uses the same schema_migrations table
 * as AG-002 (versions 1, 2) and AG-003 (versions 100-103) with distinct version
 * numbers 200+ to avoid conflicts.
 */

export interface ToolSchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** AG-004 migrations with version numbers starting at 200. */
export const TOOL_SCHEMA_MIGRATIONS: readonly ToolSchemaMigration[] = [
  {
    version: 200,
    name: 'tool-definitions-table',
    sql: `
CREATE TABLE IF NOT EXISTS tool_definitions (
  id                TEXT        PRIMARY KEY,
  name              TEXT        NOT NULL,
  description       TEXT        NOT NULL DEFAULT '',
  version           TEXT        NOT NULL,
  category          TEXT        NOT NULL,
  security_level    TEXT        NOT NULL DEFAULT 'INTERNAL',
  permissions       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  execution_policy  JSONB       NOT NULL,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  namespace         TEXT        NOT NULL DEFAULT 'default',
  CONSTRAINT tool_def_id_valid CHECK (id <> ''),
  CONSTRAINT tool_def_name_valid CHECK (name <> '')
);

CREATE INDEX IF NOT EXISTS tool_definitions_name_idx ON tool_definitions (name);
CREATE INDEX IF NOT EXISTS tool_definitions_category_idx ON tool_definitions (category);
CREATE INDEX IF NOT EXISTS tool_definitions_enabled_idx ON tool_definitions (enabled);
CREATE INDEX IF NOT EXISTS tool_definitions_created_at_idx ON tool_definitions (created_at);
CREATE INDEX IF NOT EXISTS tool_definitions_updated_at_idx ON tool_definitions (updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS tool_definitions_name_version_idx ON tool_definitions (name, version);
`,
  },
  {
    version: 201,
    name: 'tool-versions-table',
    sql: `
CREATE TABLE IF NOT EXISTS tool_versions (
  id                TEXT        PRIMARY KEY,
  tool_id           TEXT        NOT NULL REFERENCES tool_definitions(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  version           TEXT        NOT NULL,
  description       TEXT        NOT NULL DEFAULT '',
  category          TEXT        NOT NULL,
  security_level    TEXT        NOT NULL DEFAULT 'INTERNAL',
  permissions       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  execution_policy  JSONB       NOT NULL,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL,
  namespace         TEXT        NOT NULL DEFAULT 'default',
  CONSTRAINT tool_versions_unique UNIQUE (tool_id, version)
);

CREATE INDEX IF NOT EXISTS tool_versions_tool_id_idx ON tool_versions (tool_id);
CREATE INDEX IF NOT EXISTS tool_versions_name_idx ON tool_versions (name);
`,
  },
  {
    version: 202,
    name: 'tool-events-table',
    sql: `
CREATE TABLE IF NOT EXISTS tool_events (
  event_id          TEXT        PRIMARY KEY,
  sequence          BIGINT      NOT NULL,
  type              TEXT        NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  trace_id          TEXT        NOT NULL,
  namespace         TEXT        NOT NULL,
  tool_id           TEXT,
  tool_name         TEXT,
  tool_version      TEXT,
  version_id        TEXT,
  execution_id      TEXT,
  actor_group       TEXT,
  actor_id          TEXT,
  organization_id   TEXT,
  workspace_id      TEXT,
  project_id        TEXT,
  request_id        TEXT,
  correlation_id    TEXT,
  source            TEXT,
  service           TEXT,
  severity          TEXT,
  category          TEXT,
  status            TEXT,
  error_code        TEXT,
  reason            TEXT,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT tool_events_sequence_unique UNIQUE (sequence)
);

CREATE INDEX IF NOT EXISTS tool_events_type_idx ON tool_events (type);
CREATE INDEX IF NOT EXISTS tool_events_tool_id_idx ON tool_events (tool_id);
CREATE INDEX IF NOT EXISTS tool_events_namespace_idx ON tool_events (namespace);
CREATE INDEX IF NOT EXISTS tool_events_occurred_at_idx ON tool_events (occurred_at);
`,
  },
];

/** Current schema version. */
export const TOOL_SCHEMA_VERSION: number = TOOL_SCHEMA_MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

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
 * Runs all pending AG-004 migrations. Uses the same schema_migrations table
 * as AG-002/AG-003 with distinct version numbers (200+).
 */
export async function migrateToolSchema(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
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
    for (const migration of [...TOOL_SCHEMA_MIGRATIONS].sort((a, b) => a.version - b.version)) {
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
        throw new ToolStorageError(
          `Tool schema migration ${migration.version} (${migration.name}) failed`,
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

/** Returns the number of pending AG-004 migrations. */
export async function toolPendingMigrations(pool: pg.Pool): Promise<number> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return TOOL_SCHEMA_MIGRATIONS.length;
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
    return TOOL_SCHEMA_MIGRATIONS.filter((m) => !applied.has(m.version)).length;
  } finally {
    client.release();
  }
}
