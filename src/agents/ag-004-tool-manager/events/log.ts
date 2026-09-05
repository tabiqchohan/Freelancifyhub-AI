import { randomUUID } from 'node:crypto';

import { ToolConflictError, ToolEventError } from '../errors/index.js';
import type { ToolEventType } from '../enums/index.js';
import type {
  StoredToolEvent,
  ToolEvent,
  ToolEventCategory,
  ToolEventSeverity,
  ToolEventSource,
} from './index.js';
import { toolCategoryForType, toolSeverityForType, toolSourceForType } from './index.js';

/**
 * In-memory append-only event log for tool audit events. Mirrors AG-002's
 * InMemoryEventLog and AG-003's KnowledgeEventLog patterns. Never carries
 * tool input/output; only safe metadata.
 */

/** Options for the event log. */
export interface ToolEventLogOptions {
  readonly maxPageSize?: number;
  readonly maxBatchSize?: number;
  readonly eventIdFactory?: () => string;
}

/** Page of events. */
export interface ToolEventPage {
  readonly items: readonly StoredToolEvent[];
  readonly hasMore: boolean;
  readonly total: number;
  readonly pageSize: number;
}

/** Query filter. */
export interface ToolEventFilter {
  readonly type?: ToolEventType;
  readonly toolId?: string;
  readonly namespace?: string;
  readonly actorId?: string;
  readonly executionId?: string;
}

/** Query input. */
export interface ToolEventQuery {
  readonly type?: ToolEventType;
  readonly toolId?: string;
  readonly namespace?: string;
  readonly actorId?: string;
  readonly executionId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly maxPageSize?: number;
}

function defaultEventIdFactory(): string {
  return `tev_${randomUUID()}`;
}

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

function matchesFilter(event: StoredToolEvent, filter: ToolEventFilter): boolean {
  if (filter.type !== undefined && event.type !== filter.type) {
    return false;
  }
  if (filter.toolId !== undefined && event.toolId !== filter.toolId) {
    return false;
  }
  if (filter.namespace !== undefined && event.namespace !== filter.namespace) {
    return false;
  }
  if (filter.actorId !== undefined && event.actorId !== filter.actorId) {
    return false;
  }
  if (filter.executionId !== undefined && event.executionId !== filter.executionId) {
    return false;
  }
  return true;
}

/** In-memory append-only tool event log. */
export class ToolEventLog {
  readonly name = 'tool-event-log';
  readonly backend = 'in-memory';

  private readonly maxPageSize: number;
  private readonly maxBatchSize: number;
  private readonly eventIdFactory: () => string;

  private readonly stored: StoredToolEvent[] = [];
  private readonly byId = new Map<string, StoredToolEvent>();
  private nextSequence = 0;

  /** Maximum events returned per page. */
  get pageSize(): number {
    return this.maxPageSize;
  }

  /** Maximum events accepted per append batch (reserved; append is single). */
  get batchSize(): number {
    return this.maxBatchSize;
  }

  constructor(options: ToolEventLogOptions = {}) {
    this.maxPageSize = options.maxPageSize ?? 50;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.eventIdFactory = options.eventIdFactory ?? defaultEventIdFactory;
  }

  append(event: ToolEvent): StoredToolEvent {
    if (!event.type || !event.traceId || !event.occurredAt || !event.namespace) {
      throw new ToolEventError('Event missing required fields', {
        code: 'EVENT_VALIDATION_FAILED',
      });
    }

    const eventId = event.eventId ?? this.eventIdFactory();
    if (this.byId.has(eventId)) {
      throw new ToolConflictError(`Duplicate event id: ${eventId}`, { details: { eventId } });
    }

    const severity: ToolEventSeverity = event.severity ?? toolSeverityForType(event.type);
    const category: ToolEventCategory = event.category ?? toolCategoryForType(event.type);
    const source: ToolEventSource = event.source ?? toolSourceForType(event.type);

    const stored: StoredToolEvent = {
      eventId,
      type: event.type,
      occurredAt: event.occurredAt,
      timestamp: event.timestamp ?? event.occurredAt,
      sequence: this.nextSequence,
      traceId: event.traceId,
      correlationId: event.correlationId,
      requestId: event.requestId,
      namespace: event.namespace,
      toolId: event.toolId,
      toolName: event.toolName,
      toolVersion: event.toolVersion,
      versionId: event.versionId,
      executionId: event.executionId,
      actorId: event.actorId,
      actorGroup: event.actorGroup,
      organizationId: event.organizationId,
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      source,
      service: event.service,
      severity,
      category,
      status: event.status,
      errorCode: event.errorCode,
      reason: event.reason,
      metadata: event.metadata,
    };

    deepFreeze(stored);
    this.stored.push(stored);
    this.byId.set(eventId, stored);
    this.nextSequence += 1;
    return stored;
  }

  getById(eventId: string): StoredToolEvent | undefined {
    return this.byId.get(eventId);
  }

  query(query: ToolEventQuery): ToolEventPage {
    const limit = Math.max(1, Math.min(query.limit ?? this.maxPageSize, this.maxPageSize));

    const filter: ToolEventFilter = {
      type: query.type,
      toolId: query.toolId,
      namespace: query.namespace,
      actorId: query.actorId,
      executionId: query.executionId,
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

  count(filter?: ToolEventFilter): number {
    if (filter === undefined) {
      return this.stored.length;
    }
    return this.stored.filter((event) => matchesFilter(event, filter)).length;
  }

  latest(limit?: number): readonly StoredToolEvent[] {
    const resolved = Math.max(1, Math.min(limit ?? this.maxPageSize, this.maxPageSize));
    return this.stored.slice(Math.max(0, this.stored.length - resolved)).reverse();
  }
}

/** Creates a ToolEventLog with validated options. */
export function createToolEventLog(options: ToolEventLogOptions = {}): ToolEventLog {
  return new ToolEventLog(options);
}
