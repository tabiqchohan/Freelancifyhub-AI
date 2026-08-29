import { randomUUID } from 'node:crypto';

import { MemoryDuplicateEventError, MemoryEventValidationError } from '../errors/index.js';
import { SystemClock } from '../clock/index.js';
import type { Clock } from '../clock/index.js';
import type {
  MemoryEvent,
  MemoryEventCategory,
  MemoryEventId,
  MemoryEventSeverity,
  MemoryEventSource,
  MemoryEventType,
} from './index.js';
import type { StoredMemoryEvent } from './model.js';
import { categoryForType, severityForType, sourceForType } from './model.js';
import type { EventLogQuery, EventLogPage, EventLogFilter } from './query.js';
import {
  compareStoredEvents,
  decodeEventCursor,
  encodeEventCursor,
  eventAfterCursor,
  eventMatchesFilter,
} from './query.js';
import { resolveEventLimit, validateMemoryEvent } from './validation.js';
import { metadataContainsSecret, sanitizeEventMetadata } from './sanitize.js';

/**
 * Sprint 7 — Event Log / Audit Trail (spec §6–§18).
 *
 * A deterministic, append-only, immutable event log. Normal consumers cannot
 * mutate historical events — there is no `update` and no `delete`. The concrete
 * implementation is in-process/in-memory; a future durable EventStore can
 * implement the same {@link EventLogContract} without changing consumers.
 */

/** Capabilities an EventLog adapter actually supports (spec §6, §17). */
export type EventLogCapability =
  'append' | 'appendBatch' | 'query' | 'pagination' | 'getById' | 'immutable' | 'sanitize';

/** Declared capabilities of an EventLog adapter. */
export interface EventLogCapabilities {
  readonly name: string;
  readonly backend: string;
  readonly capabilities: readonly EventLogCapability[];
  supports?(capability: EventLogCapability): boolean;
}

/** Runtime health snapshot of the EventLog (spec §17). */
export interface EventLogHealth {
  readonly healthy: boolean;
  readonly checkedAt: string;
  readonly stored: number;
  readonly lastEventAt?: string;
  readonly message: string;
}

/** Safe, aggregate EventLog metrics (spec §17). Never exposes event content. */
export interface EventLogMetrics {
  readonly appended: number;
  readonly rejected: number;
  readonly queried: number;
  readonly appendDurationMs: number;
  readonly queryDurationMs: number;
  readonly validationFailures: number;
  readonly sanitized: number;
  readonly typeCounts: Readonly<Partial<Record<MemoryEventType, number>>>;
}

/** Options for constructing / configuring an in-memory EventLog. */
export interface EventLogOptions {
  readonly clock?: Clock;
  readonly maxPageSize?: number;
  readonly maxBatchSize?: number;
  /** Injectable deterministic id generator (spec §8). */
  readonly eventIdFactory?: () => MemoryEventId;
  /** When true, event metadata is sanitized on append (default true). */
  readonly sanitize?: boolean;
}

/**
 * The EventLog contract (spec §6). Append-only: no update, no delete. If future
 * retention is required it must be modelled as a policy, not arbitrary mutation.
 */
export interface EventLogContract {
  readonly name: string;
  readonly backend: string;
  /** Appends a single event after validation + sanitization. */
  append(event: MemoryEvent): StoredMemoryEvent;
  /** Appends many events atomically (validated, bounded by maxBatchSize). */
  appendBatch(events: readonly MemoryEvent[]): readonly StoredMemoryEvent[];
  /** Reads a single stored event by id; undefined when missing. */
  getById(eventId: MemoryEventId): StoredMemoryEvent | undefined;
  /** Deterministic paginated query over the audit trail. */
  query(query: EventLogQuery): EventLogPage;
  /** Number of stored events matching an optional filter (undefined => all). */
  count(filter?: EventLogFilter): number;
  /** The most recently appended events (deterministic reverse order). */
  latest(limit?: number): readonly StoredMemoryEvent[];
  health(): EventLogHealth;
  capabilities(): EventLogCapabilities;
  metrics(): EventLogMetrics;
}

/** Deeply freezes an event so neither the store nor returned snapshots mutate. */
function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') {
        deepFreeze(child);
      }
    }
  }
}

const defaultEventIdFactory = (): MemoryEventId => `evt_${randomUUID()}`;

const EMPTY_PENDING: readonly StoredMemoryEvent[] = [];

/** In-memory append-only EventLog implementation. */
export class InMemoryEventLog implements EventLogContract {
  readonly name = 'in-memory-event-log';
  readonly backend = 'in-memory';

  private readonly clock: Clock;
  private readonly maxPageSize: number;
  private readonly maxBatchSize: number;
  private readonly eventIdFactory: () => MemoryEventId;
  private readonly sanitize: boolean;

  private readonly stored: StoredMemoryEvent[] = [];
  private readonly byId = new Map<MemoryEventId, StoredMemoryEvent>();
  private nextSequence = 0;

  private appended = 0;
  private rejected = 0;
  private queried = 0;
  private appendDurationMs = 0;
  private queryDurationMs = 0;
  private validationFailures = 0;
  private sanitized = 0;

  constructor(options: EventLogOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.maxPageSize = options.maxPageSize ?? 50;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.eventIdFactory = options.eventIdFactory ?? defaultEventIdFactory;
    this.sanitize = options.sanitize ?? true;
  }

  append(event: MemoryEvent): StoredMemoryEvent {
    const started = this.clock.getNow().getTime();
    const stored = this.host(event);
    this.stored.push(stored);
    this.byId.set(stored.eventId, stored);
    this.nextSequence += 1;
    this.appended += 1;
    this.appendDurationMs += this.clock.getNow().getTime() - started;
    return stored;
  }

  appendBatch(events: readonly MemoryEvent[]): readonly StoredMemoryEvent[] {
    if (events.length > this.maxBatchSize) {
      this.rejected += 1;
      throw new MemoryEventValidationError(
        `Event batch of ${events.length} exceeds the configured maximum of ${this.maxBatchSize}`,
        { code: 'EVENT_BATCH_TOO_LARGE' },
      );
    }
    // Build the full set first so the whole batch is atomic: nothing is
    // appended if any element fails validation or duplicates.
    const hosted: StoredMemoryEvent[] = [];
    for (const event of events) {
      const stored = this.previewHost(event, hosted);
      hosted.push(stored);
    }
    for (const stored of hosted) {
      this.stored.push(stored);
      this.byId.set(stored.eventId, stored);
    }
    this.nextSequence += hosted.length;
    this.appended += hosted.length;
    return hosted;
  }

  getById(eventId: MemoryEventId): StoredMemoryEvent | undefined {
    return this.byId.get(eventId);
  }

  query(query: EventLogQuery): EventLogPage {
    const started = this.clock.getNow().getTime();
    const limit = resolveEventLimit(query.limit, query.maxPageSize);
    this.queried += 1;

    const filter: EventLogFilter = {
      type: query.type,
      eventTypes: query.eventTypes,
      memoryId: query.memoryId,
      actorId: query.actorId,
      organizationId: query.organizationId,
      workspaceId: query.workspaceId,
      projectId: query.projectId,
      traceId: query.traceId,
      requestId: query.requestId,
      correlationId: query.correlationId,
      severity: query.severity,
      category: query.category,
      from: query.from,
      to: query.to,
      version: query.version,
      lifecycleState: query.lifecycleState,
    };

    const matched = this.stored.filter((event) => eventMatchesFilter(event, filter));
    const total = matched.length;

    let cursor: { s: number; e: string } | undefined;
    if (query.cursor !== undefined) {
      cursor = decodeEventCursor(query.cursor);
    }

    const start = cursor === undefined ? 0 : matched.findIndex((e) => eventAfterCursor(e, cursor));
    const from = start < 0 ? matched.length : start;

    const pageItems = matched.slice(from, from + limit);
    const hasMore = from + limit < total;
    const last = pageItems[pageItems.length - 1];
    const nextCursor =
      hasMore && last !== undefined ? encodeEventCursor(last.sequence, last.eventId) : undefined;

    const ended = this.clock.getNow().getTime();
    this.queryDurationMs += ended - started;
    return {
      items: pageItems,
      nextCursor,
      hasMore,
      total,
      pageSize: pageItems.length,
    };
  }

  count(filter?: EventLogFilter): number {
    if (filter === undefined) {
      return this.stored.length;
    }
    return this.stored.filter((event) => eventMatchesFilter(event, filter)).length;
  }

  latest(limit?: number): readonly StoredMemoryEvent[] {
    const resolved = resolveEventLimit(limit, this.maxPageSize);
    const slice = this.stored.slice(Math.max(0, this.stored.length - resolved));
    return [...slice].sort(compareStoredEvents).reverse();
  }

  health(): EventLogHealth {
    const last = this.stored[this.stored.length - 1];
    return {
      healthy: true,
      checkedAt: this.clock.getNow().toISOString(),
      stored: this.stored.length,
      lastEventAt: last?.occurredAt,
      message: 'event log healthy',
    };
  }

  capabilities(): EventLogCapabilities {
    return {
      name: 'in-memory-event-log-capabilities',
      backend: this.backend,
      capabilities: [
        'append',
        'appendBatch',
        'query',
        'pagination',
        'getById',
        'immutable',
        'sanitize',
      ],
      supports(capability: EventLogCapability): boolean {
        return this.capabilities.includes(capability);
      },
    };
  }

  metrics(): EventLogMetrics {
    const typeCounts: Partial<Record<MemoryEventType, number>> = {};
    for (const event of this.stored) {
      typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1;
    }
    return {
      appended: this.appended,
      rejected: this.rejected,
      queried: this.queried,
      appendDurationMs: this.appendDurationMs,
      queryDurationMs: this.queryDurationMs,
      validationFailures: this.validationFailures,
      sanitized: this.sanitized,
      typeCounts,
    };
  }

  /** Non-mutating host used by `append` (checks only the global map). */
  private host(event: MemoryEvent): StoredMemoryEvent {
    return this.previewHost(event, EMPTY_PENDING);
  }

  /**
   * Validates, normalises and (optionally) sanitizes a raw transport event into
   * a canonical stored event, then deep-freezes it for immutability (spec §4,
   * §5, §7). `pending` carries events already accepted in the current batch so
   * duplicate ids within one batch are rejected before anything is appended.
   */
  private previewHost(
    event: MemoryEvent,
    pending: readonly StoredMemoryEvent[],
  ): StoredMemoryEvent {
    let input;
    try {
      input = validateMemoryEvent(event as unknown as Record<string, unknown>);
    } catch {
      this.validationFailures += 1;
      this.rejected += 1;
      throw new MemoryEventValidationError('Cannot append a malformed audit event to the EventLog');
    }

    const eventId = input.eventId ?? this.eventIdFactory();
    if (this.byId.has(eventId) || pending.some((stored) => stored.eventId === eventId)) {
      this.rejected += 1;
      throw new MemoryDuplicateEventError(`Duplicate event id: ${eventId}`, {
        details: { eventId },
      });
    }

    const occurredAt = input.occurredAt;
    const severity: MemoryEventSeverity = event.severity ?? severityForType(event.type);
    const category: MemoryEventCategory = event.category ?? categoryForType(event.type);
    const source: MemoryEventSource | undefined = event.source ?? sourceForType(event.type);

    const secretInMetadata = metadataContainsSecret(event.metadata);
    let metadata = sanitizeEventMetadata(event.metadata);
    if (secretInMetadata) {
      this.sanitized += 1;
    }
    if (!this.sanitize) {
      metadata = event.metadata;
    }

    const stored: StoredMemoryEvent = {
      eventId,
      type: event.type,
      eventType: event.type,
      occurredAt,
      timestamp: occurredAt,
      sequence: this.nextSequence + pending.length,
      traceId: event.traceId,
      correlationId: event.correlationId,
      requestId: event.requestId,
      namespace: event.namespace,
      key: event.key,
      memoryId: event.memoryId,
      actorId: event.actorId,
      actorType: event.actorType,
      actorGroup: event.actorGroup,
      organizationId: event.organizationId,
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      previousState: event.previousState,
      newState: event.newState,
      version: event.version,
      previousVersion: event.previousVersion,
      source,
      service: event.service,
      severity,
      category,
      reason: event.reason,
      hard: event.hard,
      archiveId: event.archiveId,
      count: event.count,
      permission: event.permission,
      targetType: event.targetType,
      targetSecurityLevel: event.targetSecurityLevel,
      denialReason: event.denialReason,
      denialCode: event.denialCode,
      consolidationId: event.consolidationId,
      sourceIds: event.sourceIds ? [...event.sourceIds] : undefined,
      outputId: event.outputId,
      candidateGroupSize: event.candidateGroupSize,
      metadata,
    };

    deepFreeze(stored);
    return stored;
  }
}

/** Creates an {@link InMemoryEventLog} with validated options. */
export function createEventLog(options: EventLogOptions = {}): InMemoryEventLog {
  return new InMemoryEventLog(options);
}

/**
 * Bridges an existing {@link MemoryEventEmitter} consumer signature to the
 * EventLog without touching the emitting services (spec §15, §16). Pass the
 * returned handler to `emitter.on(...)`: every emitted event is mirrored through
 * validation + sanitization into the log so the audit trail stays truthful and
 * no false success events are invented.
 */
export function createEventLogRecorder(log: EventLogContract): (event: MemoryEvent) => void {
  return (event: MemoryEvent) => {
    log.append(event);
  };
}
