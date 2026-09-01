import { MemoryConfigurationError } from '../errors/index.js';
import {
  createDurableStorageAdapter,
  registerDurableBackend,
  type DurableStorageAdapter,
  type DurableStorageOptions,
} from './durable.js';
import { PostgresStorageAdapter, createPostgresPool } from './postgres.js';
import { migrateSchema } from './schema.js';
import type pg from 'pg';

/**
 * Sprint 13 — registration of the real PostgreSQL durable backend.
 *
 * The factory {@link buildPostgresBackend} constructs a real {@link
 * PostgresStorageAdapter} from a PostgreSQL connection string (explicit option,
 * or `process.env.MEMORY_DATABASE_URL`) and applies the deterministic schema
 * migrations. It FAILS CLOSED (typed {@link MemoryConfigurationError}) when the
 * connection string is missing or empty — durable storage is never silently
 * substituted with a non-durable backend.
 */

/** Environment variable that carries the PostgreSQL connection string. */
export const MEMORY_DATABASE_URL_ENV = 'MEMORY_DATABASE_URL';

/** Reads the PostgreSQL connection string (option > env), fail-closed on missing. */
export function resolvePostgresConnectionString(options?: DurableStorageOptions): string {
  const explicit =
    typeof options?.connection === 'string' && options.connection.trim().length > 0
      ? options.connection
      : undefined;
  const fromEnv = process.env[MEMORY_DATABASE_URL_ENV];
  const value = explicit ?? fromEnv;
  if (value === undefined || value.trim().length === 0) {
    throw new MemoryConfigurationError(
      `Durable storage requires ${MEMORY_DATABASE_URL_ENV} to select the real PostgreSQL ` +
        'backend. No connection string was provided and the backend cannot fail open ' +
        'to in-memory (non-durable) storage.',
      { details: { backend: 'postgres' } },
    );
  }
  return value.trim();
}

/** Creates a live adapter instance, applying schema migrations before returning. */
export async function createPostgresAdapter(
  options?: DurableStorageOptions,
): Promise<PostgresStorageAdapter> {
  const connectionString = resolvePostgresConnectionString(options);
  const pool: pg.Pool = createPostgresPool(connectionString);
  const adapter = new PostgresStorageAdapter(pool);
  try {
    await migrateSchema(pool);
  } catch (error) {
    await adapter.close().catch(() => undefined);
    throw error;
  }
  return adapter;
}

/**
 * Synchronous factory registered in the durable backend registry. Because the
 * adapter is constructed synchronously by the contract
 * (`registerDurableBackend(name, () => DurableStorageAdapter)`), it resolves the
 * connection string synchronously (fail-closed) and defers asynchronous schema
 * migration to the first durable write via a lazily-migrated adapter.
 *
 * Callers who can await — e.g. the application bootstrap — should prefer
 * {@link createPostgresAdapter}, which also completes migrations before use.
 */
export function buildPostgresBackend(options?: DurableStorageOptions): DurableStorageAdapter {
  const connectionString = resolvePostgresConnectionString(options);
  const pool: pg.Pool = createPostgresPool(connectionString);
  return new PostgresStorageAdapter(pool);
}

/** Registers the real Postgres backend once. Returns true on first registration. */
export function registerPostgresBackend(options?: DurableStorageOptions): boolean {
  const previous = registerDurableBackend('postgres', () => buildPostgresBackend(options));
  return previous === undefined;
}

/** Returns the registered Postgres adapter (throws if not the durable backend). */
export function postgresAdapter(): PostgresStorageAdapter {
  return createDurableStorageAdapter('postgres') as PostgresStorageAdapter;
}

export { PostgresStorageAdapter, createPostgresPool } from './postgres.js';
export { migrateSchema, SCHEMA_VERSION, pendingMigrations } from './schema.js';
