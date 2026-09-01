import type { MemoryRecord, MemorySource } from '../types/index.js';

/**
 * Sprint 13 — canonical mapping between {@link MemoryRecord} domain values and
 * PostgreSQL rows. Timestamps are ISO-8601 strings in the domain and
 * TIMESTAMPTZ (JS Date) in the database; structured fields (owner, content,
 * metadata, retention, source) are JSONB. Round-trips preserve exact domain
 * semantics (spec §4).
 */

export interface MemoryRow {
  readonly id: string;
  readonly namespace: string;
  readonly key: string;
  readonly type: string;
  readonly owner: unknown;
  readonly content: unknown;
  readonly metadata: unknown;
  readonly priority: string;
  readonly security_level: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly expires_at: Date | null;
  readonly ttl_ms: number | string | null;
  readonly retention: unknown;
  readonly version: number;
  readonly lifecycle: string;
  readonly reason: string;
  readonly trace_id: string;
  readonly source: unknown;
}

function iso(value: Date | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Maps a raw database row into a domain {@link MemoryRecord}. */
export function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    type: row.type as MemoryRecord['type'],
    owner: row.owner as MemoryRecord['owner'],
    content: row.content as MemoryRecord['content'],
    metadata: (row.metadata ?? {}) as MemoryRecord['metadata'],
    priority: row.priority as MemoryRecord['priority'],
    securityLevel: row.security_level as MemoryRecord['securityLevel'],
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
    expiresAt: iso(row.expires_at),
    ttlMs:
      row.ttl_ms === null || row.ttl_ms === undefined
        ? undefined
        : typeof row.ttl_ms === 'string'
          ? Number.parseInt(row.ttl_ms, 10)
          : row.ttl_ms,
    retention: (row.retention ?? { kind: 'none' }) as MemoryRecord['retention'],
    version: row.version,
    lifecycle: row.lifecycle as MemoryRecord['lifecycle'],
    reason: row.reason,
    traceId: row.trace_id,
    source: (row.source as MemorySource | null) ?? undefined,
  };
}

/** Builds a parameter array for an INSERT matching {@link memoryRecordColumnNames}. */
export function recordToParams(record: MemoryRecord): unknown[] {
  return [
    record.id,
    record.namespace,
    record.key,
    record.type,
    JSON.stringify(record.owner),
    JSON.stringify(record.content),
    JSON.stringify(record.metadata),
    record.priority,
    record.securityLevel,
    record.createdAt,
    record.updatedAt,
    record.expiresAt ?? null,
    record.ttlMs ?? null,
    JSON.stringify(record.retention),
    record.version,
    record.lifecycle,
    record.reason,
    record.traceId,
    record.source === undefined ? null : JSON.stringify(record.source),
  ];
}

/** Column order matching {@link recordToParams} (for INSERT ... VALUES ($1..$19)). */
export const memoryRecordColumnNames =
  'id, namespace, key, type, owner, content, metadata, priority, security_level, ' +
  'created_at, updated_at, expires_at, ttl_ms, retention, version, lifecycle, reason, trace_id, source';
