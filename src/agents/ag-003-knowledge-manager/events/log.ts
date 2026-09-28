import { randomUUID } from 'node:crypto';

import { KnowledgeEventValidationError, KnowledgeConflictError } from '../errors/index.js';
import type {
  KnowledgeEvent,
  KnowledgeAuditEventType,
  KnowledgeEventSeverity,
  KnowledgeEventCategory,
  KnowledgeEventSource,
} from './index.js';
import type { StoredKnowledgeEvent } from './index.js';
import {
  knowledgeCategoryForType,
  knowledgeSeverityForType,
  knowledgeSourceForType,
} from './index.js';

/**
 * In-memory append-only event log for knowledge audit events.
 * Mirrors AG-002's InMemoryEventLog pattern.
 */

/** Options for the event log. */
export interface KnowledgeEventLogOptions {
  readonly maxPageSize?: number;
  readonly maxBatchSize?: number;
  readonly eventIdFactory?: () => string;
  /**
   * Maximum retained in-memory events (Sprint 34 §17/§19). Oldest events are
   * dropped FIFO past the cap; sequence numbers keep increasing so cursors
   * and dedupe stay valid.
   */
  readonly maxStoredEvents?: number;
}

/** Page of events. */
export interface KnowledgeEventPage {
  readonly items: readonly StoredKnowledgeEvent[];
  readonly hasMore: boolean;
  readonly total: number;
  readonly pageSize: number;
}

/** Query filter. */
export interface KnowledgeEventFilter {
  readonly type?: KnowledgeAuditEventType;
  readonly knowledgeId?: string;
  readonly namespace?: string;
  readonly actorId?: string;
}

/** Query input. */
export interface KnowledgeEventQuery {
  readonly type?: KnowledgeAuditEventType;
  readonly knowledgeId?: string;
  readonly namespace?: string;
  readonly actorId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly maxPageSize?: number;
}

function defaultEventIdFactory(): string {
  return `kevt_${randomUUID()}`;
}

const DEFAULT_MAX_STORED_EVENTS = 20_000;

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

function matchesFilter(event: StoredKnowledgeEvent, filter: KnowledgeEventFilter): boolean {
  if (filter.type !== undefined && event.type !== filter.type) {
    return false;
  }
  if (filter.knowledgeId !== undefined && event.knowledgeId !== filter.knowledgeId) {
    return false;
  }
  if (filter.namespace !== undefined && event.namespace !== filter.namespace) {
    return false;
  }
  if (filter.actorId !== undefined && event.actorId !== filter.actorId) {
    return false;
  }
  return true;
}

/** In-memory append-only knowledge event log. */
export class KnowledgeEventLog {
  readonly name = 'knowledge-event-log';
  readonly backend = 'in-memory';

  private readonly maxPageSize: number;
  private readonly maxBatchSize: number;
  private readonly maxStoredEvents: number;
  private readonly eventIdFactory: () => string;

  private readonly stored: StoredKnowledgeEvent[] = [];
  private readonly byId = new Map<string, StoredKnowledgeEvent>();
  private nextSequence = 0;

  constructor(options: KnowledgeEventLogOptions = {}) {
    this.maxPageSize = options.maxPageSize ?? 50;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.maxStoredEvents = options.maxStoredEvents ?? DEFAULT_MAX_STORED_EVENTS;
    this.eventIdFactory = options.eventIdFactory ?? defaultEventIdFactory;
  }

  append(event: KnowledgeEvent): StoredKnowledgeEvent {
    if (!event.type || !event.traceId || !event.occurredAt || !event.namespace) {
      throw new KnowledgeEventValidationError('Event missing required fields');
    }

    const eventId = event.eventId ?? this.eventIdFactory();
    if (this.byId.has(eventId)) {
      throw new KnowledgeConflictError(`Duplicate event id: ${eventId}`, {
        details: { eventId },
      });
    }

    const severity: KnowledgeEventSeverity = event.severity ?? knowledgeSeverityForType(event.type);
    const category: KnowledgeEventCategory = event.category ?? knowledgeCategoryForType(event.type);
    const source: KnowledgeEventSource = event.source ?? knowledgeSourceForType(event.type);

    const stored: StoredKnowledgeEvent = {
      eventId,
      type: event.type,
      occurredAt: event.occurredAt,
      timestamp: event.timestamp ?? event.occurredAt,
      sequence: this.nextSequence,
      traceId: event.traceId,
      correlationId: event.correlationId,
      requestId: event.requestId,
      namespace: event.namespace,
      knowledgeId: event.knowledgeId,
      versionId: event.versionId,
      actorId: event.actorId,
      actorGroup: event.actorGroup,
      organizationId: event.organizationId,
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      versionNumber: event.versionNumber,
      previousVersionNumber: event.previousVersionNumber,
      reason: event.reason,
      count: event.count,
      permission: event.permission,
      denialReason: event.denialReason,
      denialCode: event.denialCode,
      source,
      service: event.service,
      severity,
      category,
      metadata: event.metadata,
    };

    deepFreeze(stored);
    this.stored.push(stored);
    this.byId.set(eventId, stored);
    this.nextSequence += 1;
    this.enforceRetention();
    return stored;
  }

  appendBatch(events: readonly KnowledgeEvent[]): readonly StoredKnowledgeEvent[] {
    if (events.length > this.maxBatchSize) {
      throw new KnowledgeEventValidationError(
        `Event batch of ${events.length} exceeds maximum of ${this.maxBatchSize}`,
      );
    }
    const hosted: StoredKnowledgeEvent[] = [];
    for (const event of events) {
      const stored = this.previewHost(event, hosted);
      hosted.push(stored);
    }
    for (const stored of hosted) {
      this.stored.push(stored);
      this.byId.set(stored.eventId, stored);
    }
    this.nextSequence += hosted.length;
    this.enforceRetention();
    return hosted;
  }

  getById(eventId: string): StoredKnowledgeEvent | undefined {
    return this.byId.get(eventId);
  }

  /** FIFO bounded retention: drop the oldest events once the cap is exceeded. */
  private enforceRetention(): void {
    if (this.stored.length <= this.maxStoredEvents) return;
    const excess = this.stored.length - this.maxStoredEvents;
    const removed = this.stored.splice(0, excess);
    for (const event of removed) {
      this.byId.delete(event.eventId);
    }
  }

  query(query: KnowledgeEventQuery): KnowledgeEventPage {
    const limit = Math.max(1, Math.min(query.limit ?? this.maxPageSize, this.maxPageSize));

    const filter: KnowledgeEventFilter = {
      type: query.type,
      knowledgeId: query.knowledgeId,
      namespace: query.namespace,
      actorId: query.actorId,
    };

    const matched = this.stored.filter((event) => matchesFilter(event, filter));
    const total = matched.length;

    let start = 0;
    if (query.cursor !== undefined) {
      const idx = matched.findIndex((e) => e.eventId === query.cursor);
      if (idx >= 0) {
        start = idx + 1;
      }
    }

    const items = matched.slice(start, start + limit);
    const hasMore = start + limit < total;

    return { items, hasMore, total, pageSize: items.length };
  }

  count(filter?: KnowledgeEventFilter): number {
    if (filter === undefined) {
      return this.stored.length;
    }
    return this.stored.filter((event) => matchesFilter(event, filter)).length;
  }

  latest(limit?: number): readonly StoredKnowledgeEvent[] {
    const resolved = Math.max(1, Math.min(limit ?? this.maxPageSize, this.maxPageSize));
    return this.stored.slice(Math.max(0, this.stored.length - resolved)).reverse();
  }

  private previewHost(
    event: KnowledgeEvent,
    pending: readonly StoredKnowledgeEvent[],
  ): StoredKnowledgeEvent {
    if (!event.type || !event.traceId || !event.occurredAt || !event.namespace) {
      throw new KnowledgeEventValidationError('Event missing required fields');
    }

    const eventId = event.eventId ?? this.eventIdFactory();
    if (this.byId.has(eventId) || pending.some((s) => s.eventId === eventId)) {
      throw new KnowledgeConflictError(`Duplicate event id: ${eventId}`, { details: { eventId } });
    }

    const severity: KnowledgeEventSeverity = event.severity ?? knowledgeSeverityForType(event.type);
    const category: KnowledgeEventCategory = event.category ?? knowledgeCategoryForType(event.type);
    const source: KnowledgeEventSource = event.source ?? knowledgeSourceForType(event.type);

    const stored: StoredKnowledgeEvent = {
      eventId,
      type: event.type,
      occurredAt: event.occurredAt,
      timestamp: event.timestamp ?? event.occurredAt,
      sequence: this.nextSequence + pending.length,
      traceId: event.traceId,
      correlationId: event.correlationId,
      requestId: event.requestId,
      namespace: event.namespace,
      knowledgeId: event.knowledgeId,
      versionId: event.versionId,
      actorId: event.actorId,
      actorGroup: event.actorGroup,
      organizationId: event.organizationId,
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      versionNumber: event.versionNumber,
      previousVersionNumber: event.previousVersionNumber,
      reason: event.reason,
      count: event.count,
      permission: event.permission,
      denialReason: event.denialReason,
      denialCode: event.denialCode,
      source,
      service: event.service,
      severity,
      category,
      metadata: event.metadata,
    };

    deepFreeze(stored);
    return stored;
  }
}

/** Creates a KnowledgeEventLog with validated options. */
export function createKnowledgeEventLog(options: KnowledgeEventLogOptions = {}): KnowledgeEventLog {
  return new KnowledgeEventLog(options);
}
