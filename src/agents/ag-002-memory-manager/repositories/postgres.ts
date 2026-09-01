import { MemoryConflictError, MemoryNotFoundError } from '../errors/index.js';
import { MemoryLifecycleState, StorageTier } from '../enums/index.js';
import type { MemoryRepository } from './index.js';
import type { RepositoryPage, RepositoryQuery } from './query.js';
import {
  compareRecordsSorted,
  decodeRepositoryCursor,
  encodeRepositoryCursor,
  recordAfterCursor,
  sortValueOf,
  validateRepositoryQuery,
} from './query.js';
import type {
  MemoryStorageCapabilities,
  MemoryStorageMetrics,
  StorageHealth,
} from '../storage/capabilities.js';
import type { PostgresStorageAdapter } from '../storage/postgres.js';
import {
  memoryRecordColumnNames,
  recordToParams,
  rowToRecord,
  type MemoryRow,
} from '../storage/row-mapping.js';
import type {
  MemoryId,
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';

/**
 * Sprint 13 — PostgreSQL-backed {@link MemoryRepository}.
 *
 * Preserves the exact repository contract semantics of the in-memory repository
 * (version-guarded updates, conflict on live-exists for create, id uniqueness)
 * while persisting to a real PostgreSQL database. Authorization is never
 * performed here — it remains in the service/security layer. All SQL is
 * parameterized; no user-controlled value is concatenated into a query string.
 */

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

/** Deterministic SQL ORDER BY (and sort-derived value) for a repository sort field. */
function asRow(raw: Record<string, unknown>): MemoryRow {
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

export class PostgresMemoryRepository implements MemoryRepository {
  readonly name = 'postgres-memory-repository';

  private readonly storage: PostgresStorageAdapter;
  private conflictCount = 0;

  constructor(storage: PostgresStorageAdapter) {
    this.storage = storage;
  }

  async create(record: MemoryRecord): Promise<MemoryRecord> {
    const pool = this.storage.poolForRepository;
    const existing = await this.get(record.namespace, record.key);
    if (existing !== undefined && existing.lifecycle !== MemoryLifecycleState.Deleted) {
      this.conflictCount += 1;
      throw new MemoryConflictError(
        `Memory already exists at namespace ${record.namespace} key ${record.key}`,
        { details: { namespace: record.namespace, key: record.key } },
      );
    }
    const byId = await this.getById(record.id);
    if (byId !== undefined) {
      this.conflictCount += 1;
      throw new MemoryConflictError(`Memory id ${record.id} is already in use`, {
        details: { id: record.id },
      });
    }
    const res = await pool.query(INSERT_SQL, recordToParams(record));
    const row = res.rows[0] as Record<string, unknown>;
    return rowToRecord(asRow(row));
  }

  async get(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined> {
    const pool = this.storage.poolForRepository;
    const res = await pool.query('SELECT * FROM memory_records WHERE namespace = $1 AND key = $2', [
      namespace,
      key,
    ]);
    if (res.rows.length === 0) {
      return undefined;
    }
    return rowToRecord(asRow(res.rows[0] as Record<string, unknown>));
  }

  async getById(id: MemoryId): Promise<MemoryRecord | undefined> {
    const pool = this.storage.poolForRepository;
    const res = await pool.query('SELECT * FROM memory_records WHERE id = $1', [id]);
    if (res.rows.length === 0) {
      return undefined;
    }
    return rowToRecord(asRow(res.rows[0] as Record<string, unknown>));
  }

  async save(record: MemoryRecord): Promise<MemoryRecord> {
    const pool = this.storage.poolForRepository;
    const res = await pool.query(INSERT_SQL, recordToParams(record));
    return rowToRecord(asRow(res.rows[0] as Record<string, unknown>));
  }

  async update(
    namespace: MemoryNamespace,
    key: MemoryKey,
    expectedVersion: number,
    record: MemoryRecord,
  ): Promise<MemoryRecord> {
    const pool = this.storage.poolForRepository;
    const res = await pool.query(
      `UPDATE memory_records SET
         type = $4, owner = $5, content = $6, metadata = $7,
         priority = $8, security_level = $9, expires_at = $10, ttl_ms = $11,
         retention = $12, version = $13, lifecycle = $14, reason = $15,
         trace_id = $16, source = $17, updated_at = $18
       WHERE namespace = $1 AND key = $2 AND version = $3
       RETURNING *`,
      [
        namespace,
        key,
        expectedVersion,
        record.type,
        JSON.stringify(record.owner),
        JSON.stringify(record.content),
        JSON.stringify(record.metadata),
        record.priority,
        record.securityLevel,
        record.expiresAt ?? null,
        record.ttlMs ?? null,
        JSON.stringify(record.retention),
        record.version,
        record.lifecycle,
        record.reason,
        record.traceId,
        record.source === undefined ? null : JSON.stringify(record.source),
        record.updatedAt,
      ],
    );
    if (res.rows.length === 0) {
      const existing = await this.get(namespace, key);
      if (existing === undefined) {
        throw new MemoryNotFoundError(`Memory not found at namespace ${namespace} key ${key}`, {
          details: { namespace, key },
        });
      }
      this.conflictCount += 1;
      throw new MemoryConflictError(
        `Memory version conflict at namespace ${namespace} key ${key}: expected ${expectedVersion}, found ${existing.version}`,
        {
          details: { namespace, key, expectedVersion, foundVersion: existing.version },
        },
      );
    }
    return rowToRecord(asRow(res.rows[0] as Record<string, unknown>));
  }

  async delete(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    const pool = this.storage.poolForRepository;
    const res = await pool.query('DELETE FROM memory_records WHERE namespace = $1 AND key = $2', [
      namespace,
      key,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async eraseById(id: MemoryId): Promise<boolean> {
    const pool = this.storage.poolForRepository;
    const res = await pool.query('DELETE FROM memory_records WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async eraseByNamespace(namespace: MemoryNamespace): Promise<number> {
    const pool = this.storage.poolForRepository;
    const res = await pool.query('DELETE FROM memory_records WHERE namespace = $1', [namespace]);
    return res.rowCount ?? 0;
  }

  async list(filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]> {
    return this.storage.list(undefined, filter);
  }

  async query(input: RepositoryQuery): Promise<RepositoryPage> {
    const query = validateRepositoryQuery(input);
    const all = await this.list(query.filter);
    const total = all.length;
    const sorted = [...all].sort((a, b) => compareRecordsSorted(a, b, query.sort));

    let start = 0;
    if (query.cursor !== undefined) {
      const { sort, last } = decodeRepositoryCursor(query.cursor);
      let rec = sorted[start];
      while (rec !== undefined && !recordAfterCursor(rec, sort, last)) {
        start += 1;
        rec = sorted[start];
      }
    }

    const items = sorted.slice(start, start + query.limit);
    const hasMore = start + query.limit < sorted.length;
    let nextCursor: string | undefined;
    if (hasMore) {
      const lastRec = items[items.length - 1];
      if (lastRec !== undefined) {
        nextCursor = encodeRepositoryCursor(query.sort, {
          value: sortValueOf(lastRec, query.sort.field),
          namespace: lastRec.namespace,
          key: lastRec.key,
        });
      }
    }
    return { items, nextCursor, hasMore, total, pageSize: items.length };
  }

  async count(filter?: MemoryRecordFilter): Promise<number> {
    return (await this.list(filter)).length;
  }

  async exists(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    return (await this.get(namespace, key)) !== undefined;
  }

  capabilities(): MemoryStorageCapabilities {
    return this.storage.capabilities();
  }

  health(): StorageHealth {
    const zero = { [StorageTier.Hot]: 0, [StorageTier.Warm]: 0, [StorageTier.Cold]: 0 };
    return {
      healthy: true,
      checkedAt: new Date().toISOString(),
      stored: 0,
      tiers: zero,
      message: 'postgres repository operational',
    };
  }

  metrics(): MemoryStorageMetrics {
    const m = this.storage.metrics();
    return { ...m, conflicts: this.conflictCount };
  }
}
