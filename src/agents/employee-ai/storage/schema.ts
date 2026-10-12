import type pg from 'pg';
import { SCHEMA_MIGRATION_LOCK_KEY } from '../../ag-002-memory-manager/storage/schema.js';

/**
 * Prompts19 Phase 2 — AG-701 AI Employee schema migrations. Shares the
 * `schema_migrations` table and advisory lock with AG-002/AG-003/AG-004, using
 * distinct version numbers 300+ so concurrent DDL never collides on the
 * PostgreSQL catalog.
 */

export interface EmployeeSchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const EMPLOYEE_SCHEMA_MIGRATIONS: readonly EmployeeSchemaMigration[] = [
  {
    version: 300,
    name: 'employee-tasks-table',
    sql: `
CREATE TABLE IF NOT EXISTS employee_tasks (
  task_id            TEXT        PRIMARY KEY,
  project_id         TEXT        NOT NULL,
  client_id          TEXT        NOT NULL,
  request_text       TEXT        NOT NULL,
  request_id         TEXT        NOT NULL,
  trace_id           TEXT        NOT NULL,
  phase              TEXT        NOT NULL,
  result             JSONB       NOT NULL,
  artifact_file_name TEXT,
  artifact_sha256    TEXT,
  artifact_path      TEXT,
  started_at         BIGINT      NOT NULL,
  completed_at       BIGINT,
  updated_at         BIGINT      NOT NULL,
  expires_at         BIGINT      NOT NULL,
  CONSTRAINT employee_tasks_task_id_valid CHECK (task_id <> ''),
  CONSTRAINT employee_tasks_project_id_valid CHECK (project_id <> ''),
  CONSTRAINT employee_tasks_client_id_valid CHECK (client_id <> '')
);

CREATE INDEX IF NOT EXISTS employee_tasks_client_id_idx ON employee_tasks (client_id);
CREATE INDEX IF NOT EXISTS employee_tasks_project_id_idx ON employee_tasks (project_id);
CREATE INDEX IF NOT EXISTS employee_tasks_phase_idx ON employee_tasks (phase);
CREATE INDEX IF NOT EXISTS employee_tasks_updated_at_idx ON employee_tasks (updated_at);
CREATE INDEX IF NOT EXISTS employee_tasks_expires_at_idx ON employee_tasks (expires_at);
`,
  },
  {
    version: 301,
    name: 'employee-artifacts-table',
    sql: `
CREATE TABLE IF NOT EXISTS employee_artifacts (
  task_id     TEXT        PRIMARY KEY,
  file_name   TEXT        NOT NULL,
  sha256      TEXT        NOT NULL,
  size_bytes  BIGINT      NOT NULL,
  content     BYTEA       NOT NULL,
  expires_at  BIGINT      NOT NULL,
  CONSTRAINT employee_artifacts_task_id_valid CHECK (task_id <> ''),
  CONSTRAINT employee_artifacts_size_valid CHECK (size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS employee_artifacts_expires_at_idx ON employee_artifacts (expires_at);
`,
  },
];

export const EMPLOYEE_SCHEMA_VERSION: number = EMPLOYEE_SCHEMA_MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

function parseAppliedVersion(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isInteger(n)) return n;
  }
  return undefined;
}

/** Runs all pending AG-701 migrations under the shared advisory lock. */
export async function migrateEmployeeSchema(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [SCHEMA_MIGRATION_LOCK_KEY]);
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
      if (v !== undefined) applied.add(v);
    }

    let appliedCount = 0;
    for (const migration of [...EMPLOYEE_SCHEMA_MIGRATIONS].sort((a, b) => a.version - b.version)) {
      if (applied.has(migration.version)) continue;
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
        throw new Error(
          `Employee schema migration ${migration.version} (${migration.name}) failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        );
      }
    }
    return appliedCount;
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1::bigint)', [SCHEMA_MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}
