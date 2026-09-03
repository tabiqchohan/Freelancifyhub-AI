import type pg from 'pg';
import { KnowledgeStorageError } from '../errors/index.js';

/**
 * AG-003 Knowledge Manager schema migrations. Uses the same schema_migrations
 * table as AG-002 but with distinct version numbers (100+) to avoid conflicts.
 * AG-002 uses versions 1 and 2.
 */

export interface KnowledgeSchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** AG-003 migrations with version numbers starting at 100. */
export const KNOWLEDGE_SCHEMA_MIGRATIONS: readonly KnowledgeSchemaMigration[] = [
  {
    version: 100,
    name: 'knowledge-documents-table',
    sql: `
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                TEXT        PRIMARY KEY,
  namespace         TEXT        NOT NULL,
  title             TEXT        NOT NULL,
  content           TEXT        NOT NULL,
  content_type      TEXT        NOT NULL,
  source            JSONB       NOT NULL,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  lifecycle         TEXT        NOT NULL DEFAULT 'ACTIVE',
  security_level    TEXT        NOT NULL DEFAULT 'INTERNAL',
  version           INTEGER     NOT NULL DEFAULT 1,
  content_hash      TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  created_by        TEXT        NOT NULL,
  updated_by        TEXT        NOT NULL,
  trace_id          TEXT        NOT NULL,
  CONSTRAINT knowledge_doc_id_valid CHECK (id <> ''),
  CONSTRAINT knowledge_doc_version_positive CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS knowledge_documents_namespace_idx ON knowledge_documents (namespace);
CREATE INDEX IF NOT EXISTS knowledge_documents_lifecycle_idx ON knowledge_documents (lifecycle);
CREATE INDEX IF NOT EXISTS knowledge_documents_security_level_idx ON knowledge_documents (security_level);
CREATE INDEX IF NOT EXISTS knowledge_documents_content_hash_idx ON knowledge_documents (content_hash);
CREATE INDEX IF NOT EXISTS knowledge_documents_created_at_idx ON knowledge_documents (created_at);
CREATE INDEX IF NOT EXISTS knowledge_documents_updated_at_idx ON knowledge_documents (updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_documents_namespace_title_idx ON knowledge_documents (namespace, title);
`,
  },
  {
    version: 101,
    name: 'knowledge-versions-table',
    sql: `
CREATE TABLE IF NOT EXISTS knowledge_versions (
  id                TEXT        PRIMARY KEY,
  document_id       TEXT        NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  version_number    INTEGER     NOT NULL,
  title             TEXT        NOT NULL,
  content           TEXT        NOT NULL,
  content_type      TEXT        NOT NULL,
  source            JSONB       NOT NULL,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  security_level    TEXT        NOT NULL DEFAULT 'INTERNAL',
  content_hash      TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  created_by        TEXT        NOT NULL,
  trace_id          TEXT        NOT NULL,
  CONSTRAINT knowledge_version_number_positive CHECK (version_number >= 1),
  CONSTRAINT knowledge_version_unique UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS knowledge_versions_document_id_idx ON knowledge_versions (document_id);
CREATE INDEX IF NOT EXISTS knowledge_versions_version_number_idx ON knowledge_versions (version_number);
CREATE INDEX IF NOT EXISTS knowledge_versions_content_hash_idx ON knowledge_versions (content_hash);
`,
  },
  {
    version: 102,
    name: 'knowledge-chunks-table',
    sql: `
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id                TEXT        PRIMARY KEY,
  document_id       TEXT        NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  version_id        TEXT        NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
  version_number    INTEGER     NOT NULL,
  chunk_index       INTEGER     NOT NULL,
  content           TEXT        NOT NULL,
  content_hash      TEXT        NOT NULL,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL,
  CONSTRAINT knowledge_chunk_index_positive CHECK (chunk_index >= 0),
  CONSTRAINT knowledge_chunk_version_number_positive CHECK (version_number >= 1),
  CONSTRAINT knowledge_chunk_unique UNIQUE (version_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_document_id_idx ON knowledge_chunks (document_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_version_id_idx ON knowledge_chunks (version_id);
`,
  },
  {
    version: 103,
    name: 'knowledge-events-table',
    sql: `
CREATE TABLE IF NOT EXISTS knowledge_events (
  event_id          TEXT        PRIMARY KEY,
  sequence          BIGINT      NOT NULL,
  type              TEXT        NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  trace_id          TEXT        NOT NULL,
  namespace         TEXT        NOT NULL,
  knowledge_id      TEXT,
  version_id        TEXT,
  actor_group       TEXT,
  actor_id          TEXT,
  version_number    INTEGER,
  previous_version_number INTEGER,
  reason            TEXT,
  count             INTEGER,
  permission        TEXT,
  denial_reason     TEXT,
  denial_code       TEXT,
  correlation_id    TEXT,
  request_id        TEXT,
  organization_id   TEXT,
  workspace_id      TEXT,
  project_id        TEXT,
  source            TEXT,
  service           TEXT,
  severity          TEXT,
  category          TEXT,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT knowledge_events_sequence_unique UNIQUE (sequence)
);

CREATE INDEX IF NOT EXISTS knowledge_events_namespace_idx ON knowledge_events (namespace);
CREATE INDEX IF NOT EXISTS knowledge_events_type_idx ON knowledge_events (type);
CREATE INDEX IF NOT EXISTS knowledge_events_knowledge_id_idx ON knowledge_events (knowledge_id);
CREATE INDEX IF NOT EXISTS knowledge_events_occurred_at_idx ON knowledge_events (occurred_at);
`,
  },
];

/** Current schema version. */
export const KNOWLEDGE_SCHEMA_VERSION: number = KNOWLEDGE_SCHEMA_MIGRATIONS.reduce(
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
 * Runs all pending AG-003 migrations. Uses the same schema_migrations table
 * as AG-002. Reuses AG-002's migrateSchema to run both AG-002 and AG-003
 * migrations in version order.
 */
export async function migrateKnowledgeSchema(pool: pg.Pool): Promise<number> {
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
    for (const migration of [...KNOWLEDGE_SCHEMA_MIGRATIONS].sort(
      (a, b) => a.version - b.version,
    )) {
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
        throw new KnowledgeStorageError(
          `Knowledge schema migration ${migration.version} (${migration.name}) failed`,
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

/** Returns the number of pending AG-003 migrations. */
export async function knowledgePendingMigrations(pool: pg.Pool): Promise<number> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return KNOWLEDGE_SCHEMA_MIGRATIONS.length;
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
    return KNOWLEDGE_SCHEMA_MIGRATIONS.filter((m) => !applied.has(m.version)).length;
  } finally {
    client.release();
  }
}
