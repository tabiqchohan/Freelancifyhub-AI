import type {
  MemoryId,
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';
import { MemoryStorageError } from '../errors/index.js';
import { StorageTier } from '../enums/index.js';
import type {
  MemoryStorageCapabilities,
  MemoryStorageMetrics,
  MemoryStorageTransaction,
  StorageHealth,
} from './capabilities.js';
import { createDurableCapabilities } from './capabilities.js';
import type { DurableStorageAdapter, DurableWriteResult } from './durable.js';
import { acquireClient, migrateSchema } from './schema.js';
import {
  memoryRecordColumnNames,
  recordToParams,
  rowToRecord,
  type MemoryRow,
} from './row-mapping.js';
import pg from 'pg';

/**
 * Sprint 13 — real PostgreSQL storage adapter behind the existing
 * {@link MemoryStorageAdapter} contract. Implements {@link DurableStorageAdapter}
 * so it genuinely survives process restarts (the record lives in PostgreSQL,
 * not in process memory).
 *
 * Security: every query is parameterized — user-controlled values are never
 * concatenated into SQL. Nothing in this adapter logs, metrics, health-checks or
 * throws with connection strings, passwords or record content.
 */

export type { MemoryRow };

/** Maps a raw row to the {@link MemoryRow} shape expected by the mapper. */
type PgRow = Record<string, unknown>;

function asRow(raw: PgRow): MemoryRow {
  return {
    id: String(raw.id),
    namespace: String(raw.namespace),
    key: String(raw.key),
    type: String(raw.type),
    owner: raw.owner,
    content: raw.content,
    metadata: raw.metadata,
    priority: String(raw.priority),
    security_level: String(raw.security_level),
    created_at: raw.created_at as Date,
    updated_at: raw.updated_at as Date,
    expires_at: (raw.expires_at as Date | null) ?? null,
    ttl_ms: (raw.ttl_ms as number | string | null) ?? null,
    retention: raw.retention,
    version: Number(raw.version),
    lifecycle: String(raw.lifecycle),
    reason: String(raw.reason),
    trace_id: String(raw.trace_id),
    source: raw.source as unknown,
  };
}

const WHERE_NAMESPACE_KEY = 'namespace = $1 AND key = $2';
const WHERE_ID = 'id = $1';
const INSERT_SQL = `INSERT INTO memory_records
  (${memoryRecordColumnNames})
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
  ON CONFLICT (namespace, key) DO UPDATE SET
    owner = EXCLUDED.owner,
    content = EXCLUDED.content,
    metadata = EXCLUDED.metadata,
    priority = EXCLUDED.priority,
    security_level = EXCLUDED.security_level,
    expires_at = EXCLUDED.expires_at,
    ttl_ms = EXCLUDED.ttl_ms,
    retention = EXCLUDED.retention,
    version = EXCLUDED.version,
    lifecycle = EXCLUDED.lifecycle,
    reason = EXCLUDED.reason,
    trace_id = EXCLUDED.trace_id,
    source = EXCLUDED.source,
    updated_at = EXCLUDED.updated_at
  RETURNING *`;

/**
 * A real PostgreSQL {@link DurableStorageAdapter}.
 *
 * `transaction()` uses PostgreSQL's genuine BEGIN/COMMIT/ROLLBACK on a dedicated
 * connection: writes issued while a transaction is active are routed to that
 * connection so the whole `run` block is atomic.
 */
export class PostgresStorageAdapter implements DurableStorageAdapter {
  readonly durable = true as const;
  readonly name = 'postgres-memory-storage';

  private readonly pool: pg.Pool;
  private activeTxClient: pg.PoolClient | null = null;

  private reads = 0;
  private writes = 0;
  private queries = 0;
  private conflicts = 0;
  private observedSize = 0;
  private lastHealth: StorageHealth | null = null;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** Resolves the client instance operations should run on (tx-bound when active). */
  private async client(): Promise<pg.PoolClient | pg.Pool> {
    return this.activeTxClient ?? this.pool;
  }

  async read(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined> {
    this.reads += 1;
    const c = await this.client();
    const res = await c.query<{ id: string }>(
      `SELECT id FROM memory_records WHERE ${WHERE_NAMESPACE_KEY}`,
      [namespace, key],
    );
    if (res.rows.length === 0) {
      return undefined;
    }
    return this.getById(res.rows[0]!.id);
  }

  async getById(id: MemoryId): Promise<MemoryRecord | undefined> {
    this.reads += 1;
    const c = await this.client();
    const res = await c.query(`SELECT * FROM memory_records WHERE ${WHERE_ID}`, [id]);
    if (res.rows.length === 0) {
      return undefined;
    }
    return rowToRecord(asRow(res.rows[0] as PgRow));
  }

  async write(record: MemoryRecord, _tier?: StorageTier): Promise<void> {
    this.writes += 1;
    const c = await this.client();
    await c.query(INSERT_SQL, recordToParams(record));
  }

  /** Durable write: confirms PostgreSQL persisted via RETURNING before returning. */
  async durableWrite(record: MemoryRecord): Promise<DurableWriteResult> {
    this.writes += 1;
    const c = await this.client();
    const res = await c.query(INSERT_SQL, recordToParams(record));
    return {
      durablyPersisted: res.rows.length === 1,
      acknowledgedAt: new Date().toISOString(),
    };
  }

  /** Re-reads from PostgreSQL directly, bypassing any process-local cache. */
  async reload(namespace: string, key: string): Promise<MemoryRecord | undefined> {
    return this.read(namespace, key);
  }

  async remove(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    const c = await this.client();
    const res = await c.query(`DELETE FROM memory_records WHERE ${WHERE_NAMESPACE_KEY}`, [
      namespace,
      key,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async removeByNamespace(namespace: MemoryNamespace): Promise<number> {
    const c = await this.client();
    const res = await c.query('DELETE FROM memory_records WHERE namespace = $1', [namespace]);
    return res.rowCount ?? 0;
  }

  async list(_tier?: StorageTier, filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]> {
    this.queries += 1;
    const c = await this.client();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.namespace !== undefined) {
      params.push(filter.namespace);
      clauses.push(`namespace = $${params.length}`);
    }
    if (filter?.key !== undefined) {
      params.push(filter.key);
      clauses.push(`key = $${params.length}`);
    }
    if (filter?.type !== undefined) {
      params.push(filter.type);
      clauses.push(`type = $${params.length}`);
    }
    if (filter?.priority !== undefined) {
      params.push(filter.priority);
      clauses.push(`priority = $${params.length}`);
    }
    if (filter?.securityLevel !== undefined) {
      params.push(filter.securityLevel);
      clauses.push(`security_level = $${params.length}`);
    }
    if (filter?.lifecycle !== undefined) {
      params.push(filter.lifecycle);
      clauses.push(`lifecycle = $${params.length}`);
    }
    if (filter?.owner !== undefined) {
      params.push(filter.owner.kind);
      clauses.push(`owner->>'kind' = $${params.length}`);
      params.push(filter.owner.id);
      clauses.push(`owner->>'id' = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await c.query(`SELECT * FROM memory_records ${where} ORDER BY id`, params);
    return res.rows.map((row) => rowToRecord(asRow(row as PgRow)));
  }

  capabilities(): MemoryStorageCapabilities {
    return createDurableCapabilities('postgres');
  }

  /**
   * Synchronous health view required by the contract. Because a real database
   * probe is inherently asynchronous, this returns the last result of
   * {@link healthAsync} (or a default when none has run). Use
   * {@link healthAsync} for an up-to-date, real connectivity probe.
   */
  health(): StorageHealth {
    const tiers = {
      [StorageTier.Hot]: 0,
      [StorageTier.Warm]: 0,
      [StorageTier.Cold]: 0,
    };
    if (this.lastHealth !== null) {
      return this.lastHealth;
    }
    return {
      healthy: true,
      checkedAt: new Date().toISOString(),
      stored: this.observedSize,
      tiers,
      message: 'postgres storage operational (not yet probed)',
    };
  }

  /**
   * Real, asynchronous PostgreSQL health probe. No url/password/username is
   * surfaced in the returned health object.
   */
  async healthAsync(): Promise<StorageHealth> {
    const tiers = {
      [StorageTier.Hot]: 0,
      [StorageTier.Warm]: 0,
      [StorageTier.Cold]: 0,
    };
    let healthy = false;
    let stored = 0;
    try {
      const res = await this.pool.query('SELECT count(*)::int AS n FROM memory_records');
      healthy = true;
      stored = Number(res.rows[0]?.n ?? 0);
    } catch {
      // Probe failed; fail closed (healthy stays false).
    }
    this.observedSize = stored;
    const health: StorageHealth = {
      healthy,
      checkedAt: new Date().toISOString(),
      stored,
      tiers,
      message: healthy ? 'postgres storage operational' : 'postgres storage unavailable',
    };
    this.lastHealth = health;
    return health;
  }

  metrics(): MemoryStorageMetrics {
    return {
      reads: this.reads,
      writes: this.writes,
      conflicts: this.conflicts,
      queries: this.queries,
    };
  }

  transaction(): MemoryStorageTransaction {
    return {
      name: 'postgres-transaction',
      run: async <T>(work: () => Promise<T>): Promise<T> => {
        const client = await acquireClient(this.pool);
        this.activeTxClient = client;
        try {
          await client.query('BEGIN');
          const result = await work();
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          this.activeTxClient = null;
          client.release();
        }
      },
    };
  }

  /**
   * Synchronous clear required by the contract (observability helper). Issues a
   * best-effort asynchronous truncate and resets the local observed count. For a
   * deterministically-completed clear (e.g. in integration tests), use
   * {@link clearAsync} and await it.
   */
  clear(): void {
    this.observedSize = 0;
    void this.clearAsync();
  }

  /** Real, awaited clear of every record from PostgreSQL. */
  async clearAsync(): Promise<void> {
    const c = await this.client();
    await c.query('DELETE FROM memory_records');
    this.observedSize = 0;
  }

  /**
   * Synchronous size required by the contract (observability helper). Returns
   * the last size observed by this adapter instance. For an authoritative
   * PostgreSQL count, use {@link sizeAsync}.
   */
  size(): number {
    return this.observedSize;
  }

  /** Real, awaited record count from PostgreSQL. */
  async sizeAsync(): Promise<number> {
    const c = await this.client();
    const res = await c.query('SELECT count(*)::int AS n FROM memory_records');
    const n = Number(res.rows[0]?.n ?? 0);
    this.observedSize = n;
    return n;
  }

  /** Applies schema migrations against this adapter's pool. */
  async migrate(): Promise<number> {
    return migrateSchema(this.pool);
  }

  /** End the underlying pool (e.g. on shutdown). No secrets are surfaced. */
  async close(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }

  /**
   * Exposes the raw pool for the repository integration layer. This is the only
   * public surface that touches the driver directly; it is intentionally not a
   * raw connection (pool, not connection) and is not part of any public AG-002
   * API contract — it is a documented repository-layer seam.
   */
  get poolForRepository(): pg.Pool {
    return this.pool;
  }
}

/** Builds a PostgreSQL pool from a connection string. Throws on missing URL. */
export function createPostgresPool(connectionString: string): pg.Pool {
  if (!connectionString || connectionString.trim().length === 0) {
    throw new MemoryStorageError('PostgreSQL connection string is empty', {
      code: 'MEMORY_DATABASE_URL_MISSING',
    });
  }
  return new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    idleTimeoutMillis: 30_000,
    max: 10,
    ssl:
      connectionString.includes('sslmode=require') || connectionString.includes('sslmode=verify')
        ? { rejectUnauthorized: false }
        : undefined,
  });
}
