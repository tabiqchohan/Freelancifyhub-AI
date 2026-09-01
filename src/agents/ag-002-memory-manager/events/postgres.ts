import type pg from 'pg';
import { MemoryStorageError } from '../errors/index.js';
import type { MemoryEvent } from './index.js';
import type { EventLogContract, EventLogHealth } from './log.js';
import type { InMemoryEventLog } from './log.js';
import type { MemoryEventId, MemoryEventType } from './index.js';
import type { StoredMemoryEvent } from './model.js';

/**
 * Sprint 13 — smallest durable integration for the append-only event log
 * (Phase 13). The {@link EventLogContract} is fully synchronous, so durable
 * persistence is delivered as a write-through SINK rather than a redesigned
 * log:
 *
 *  * Canonical hosting (validation, sanitization, local sequence, dedup) is
 *    delegated to an existing {@link InMemoryEventLog} — the event system is
 *    NOT redesigned.
 *  * Every canonical event is then persisted to {@code memory_events} in
 *    PostgreSQL with a database-derived monotonic sequence, so events relevant
 *    to audit / replay / restore / tombstones / lifecycle survive a process
 *    restart.
 *  * {@link readBackStart}, {@link getById} and {@link count} read the durable
 *    copy back from PostgreSQL for audit / replay / restart verification.
 *
 * The synchronous in-memory log remains the live read path for the running
 * process; this sink guarantees the durable copy. No secrets are persisted —
 * metadata writes through the canonical {@code sanitizeEventMetadata} path and
 * is persisted as the sanitized form. Nothing here logs credentials.
 */

const EVENT_COLUMNS =
  'event_id, sequence, type, occurred_at, trace_id, namespace, key, memory_id, ' +
  'actor_group, actor_id, actor_type, version, previous_version, previous_state, new_state, ' +
  'reason, hard, metadata, correlation_id, request_id, service, severity, category, source, event_type';

interface EventRow {
  readonly event_id: string;
  readonly sequence: string | number;
  readonly type: string;
  readonly occurred_at: Date;
  readonly trace_id: string;
  readonly namespace: string;
  readonly key: string;
  readonly memory_id: string | null;
  readonly actor_group: string | null;
  readonly actor_id: string | null;
  readonly actor_type: string | null;
  readonly version: number | null;
  readonly previous_version: number | null;
  readonly previous_state: string | null;
  readonly new_state: string | null;
  readonly reason: string | null;
  readonly hard: boolean | null;
  readonly metadata: unknown;
  readonly correlation_id: string | null;
  readonly request_id: string | null;
  readonly service: string | null;
  readonly severity: string | null;
  readonly category: string | null;
  readonly source: string | null;
  readonly event_type: string | null;
}

function rowToEvent(row: EventRow): StoredMemoryEvent {
  return {
    eventId: row.event_id,
    type: row.type as MemoryEventType,
    eventType: row.event_type as MemoryEventType,
    occurredAt: row.occurred_at.toISOString(),
    timestamp: row.occurred_at.toISOString(),
    sequence: Number(row.sequence),
    traceId: row.trace_id,
    correlationId: row.correlation_id ?? undefined,
    requestId: row.request_id ?? undefined,
    namespace: row.namespace,
    key: row.key,
    memoryId: row.memory_id ?? undefined,
    actorId: row.actor_id ?? undefined,
    actorType: row.actor_type ?? undefined,
    actorGroup: row.actor_group as StoredMemoryEvent['actorGroup'],
    version: row.version ?? undefined,
    previousVersion: row.previous_version ?? undefined,
    previousState: row.previous_state as StoredMemoryEvent['previousState'],
    newState: row.new_state as StoredMemoryEvent['newState'],
    reason: row.reason ?? undefined,
    hard: row.hard ?? undefined,
    severity: (row.severity as StoredMemoryEvent['severity']) ?? 'info',
    category: (row.category as StoredMemoryEvent['category']) ?? 'memory',
    metadata: (row.metadata ?? {}) as StoredMemoryEvent['metadata'],
  };
}

function paramsFor(stored: StoredMemoryEvent): unknown[] {
  return [
    stored.eventId,
    stored.sequence,
    stored.type,
    stored.occurredAt,
    stored.traceId,
    stored.namespace,
    stored.key,
    stored.memoryId ?? null,
    stored.actorGroup ?? null,
    stored.actorId ?? null,
    stored.actorType ?? null,
    stored.version ?? null,
    stored.previousVersion ?? null,
    stored.previousState ?? null,
    stored.newState ?? null,
    stored.reason ?? null,
    stored.hard ?? null,
    JSON.stringify(stored.metadata ?? {}),
    stored.correlationId ?? null,
    stored.requestId ?? null,
    stored.service ?? null,
    stored.severity ?? null,
    stored.category ?? null,
    stored.source ?? null,
    stored.eventType,
  ];
}

const INSERT_SQL = `INSERT INTO memory_events (${EVENT_COLUMNS})
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id`;

export class PostgresEventSink {
  readonly name = 'postgres-event-sink';
  readonly backend = 'postgres';

  private readonly pool: pg.Pool;
  private readonly log: InMemoryEventLog;
  private persisted = 0;

  constructor(pool: pg.Pool, log: InMemoryEventLog) {
    this.pool = pool;
    this.log = log;
  }

  /** The synchronous canonical log this sink writes through. */
  get inMemoryLog(): EventLogContract {
    return this.log;
  }

  private async nextSequence(): Promise<number> {
    const res = await this.pool.query<{ n: string | number | null }>(
      'SELECT max(sequence)::bigint AS n FROM memory_events',
    );
    return Number(res.rows[0]?.n ?? 0) + 1;
  }

  private async insertStored(stored: StoredMemoryEvent): Promise<void> {
    const sequence = await this.nextSequence();
    const durable = { ...stored, sequence };
    await this.pool.query(INSERT_SQL, paramsFor(durable));
    this.persisted += 1;
  }

  /**
   * Canonicalizes an emitted event (validation + sanitization + local dedup)
   * and durably persists it. The returned stored event is the canonical live
   * form; the durable copy carries the database sequence.
   */
  async persist(event: MemoryEvent): Promise<StoredMemoryEvent> {
    const stored = this.log.append(event);
    try {
      await this.insertStored(stored);
    } catch (cause) {
      throw new MemoryStorageError('Failed to durably persist memory event', { cause });
    }
    return stored;
  }

  /** Canonicalizes + persists a batch, preserving event order with durable sequences. */
  async persistBatch(events: readonly MemoryEvent[]): Promise<readonly StoredMemoryEvent[]> {
    const stored = this.log.appendBatch(events);
    for (const event of stored) {
      await this.insertStored(event);
    }
    return stored;
  }

  /** Reads the most recent durable events back from PostgreSQL (audit/replay/restart). */
  async readBackStart(limit = 100): Promise<readonly StoredMemoryEvent[]> {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const res = await this.pool.query<EventRow>(
      `SELECT * FROM memory_events ORDER BY sequence ASC LIMIT ${safeLimit}`,
    );
    return res.rows.map(rowToEvent);
  }

  /** Reads durable events scoped to a namespace back from PostgreSQL. */
  async readByNamespace(namespace: string, limit = 100): Promise<readonly StoredMemoryEvent[]> {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const res = await this.pool.query<EventRow>(
      `SELECT * FROM memory_events WHERE namespace = $1 ORDER BY sequence ASC LIMIT ${safeLimit}`,
      [namespace],
    );
    return res.rows.map(rowToEvent);
  }

  /** Reads a durable event by id from PostgreSQL; undefined when absent. */
  async getById(eventId: MemoryEventId): Promise<StoredMemoryEvent | undefined> {
    const res = await this.pool.query<EventRow>('SELECT * FROM memory_events WHERE event_id = $1', [
      eventId,
    ]);
    const row = res.rows[0];
    return row === undefined ? undefined : rowToEvent(row);
  }

  /** Total durable events persisted to PostgreSQL. */
  async count(): Promise<number> {
    const res = await this.pool.query<{ n: string | number | null }>(
      'SELECT count(*)::bigint AS n FROM memory_events',
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Real durability probe. No credentials or event content are surfaced. */
  async healthAsync(): Promise<EventLogHealth> {
    let healthy = false;
    let stored = 0;
    try {
      const res = await this.pool.query<{ n: string | number | null }>(
        'SELECT count(*)::bigint AS n FROM memory_events',
      );
      healthy = true;
      stored = Number(res.rows[0]?.n ?? 0);
    } catch {
      // Probe failed; fail closed (healthy stays false).
    }
    return {
      healthy,
      checkedAt: new Date().toISOString(),
      stored,
      message: healthy ? 'event sink durably operational' : 'event sink unavailable',
    };
  }
}
