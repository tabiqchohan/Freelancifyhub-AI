import { MemoryValidationError } from '../errors/index.js';
import type { MemoryLifecycleState } from '../enums/index.js';
import type {
  IsoTimestamp,
  MemoryId,
  MemoryKey,
  MemoryNamespace,
  RequestId,
  TraceId,
} from '../types/index.js';
import type {
  MemoryEventCategory,
  MemoryEventId,
  MemoryEventSeverity,
  MemoryEventType,
} from './index.js';
import type { StoredMemoryEvent } from './model.js';

/**
 * Sprint 7 — Deterministic EventLog query / pagination contract (spec §11, §12).
 * Reuses the Sprint 6 keyset-cursor philosophy: stable ordering via a globally
 * monotonic `sequence` with the opaque `eventId` as a unique tiebreaker, so
 * repeated queries always return the same order even when timestamps collide.
 */

/** Deterministic filters supported by the EventLog (spec §11). */
export interface EventLogFilter {
  readonly type?: MemoryEventType;
  readonly eventTypes?: readonly MemoryEventType[];
  readonly memoryId?: MemoryId;
  readonly namespace?: MemoryNamespace;
  readonly key?: MemoryKey;
  readonly actorId?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly traceId?: TraceId;
  readonly requestId?: RequestId;
  readonly correlationId?: string;
  readonly severity?: MemoryEventSeverity;
  readonly category?: MemoryEventCategory;
  readonly from?: IsoTimestamp;
  readonly to?: IsoTimestamp;
  readonly version?: number;
  readonly lifecycleState?: MemoryLifecycleState;
}

/** A fully-typed EventLog query (filter + pagination). */
export interface EventLogQuery extends EventLogFilter {
  /** Maximum items on this page (validated against config maximum). */
  readonly limit?: number;
  /** Opaque continuation token from a previous page. */
  readonly cursor?: string;
  readonly maxPageSize: number;
}

/** A single, deterministic page of audit events. */
export interface EventLogPage {
  readonly items: readonly StoredMemoryEvent[];
  /** Opaque cursor for the next page, when more records remain. */
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  /** Total number of events matching the filter (before pagination). */
  readonly total: number;
  readonly pageSize: number;
}

/** The opaque cursor payload (sequence + eventId tuple). */
interface EventCursorPayload {
  readonly s: number;
  readonly e: MemoryEventId;
}

const EVENT_CURSOR_SHAPE: (keyof EventCursorPayload)[] = ['s', 'e'];

/**
 * Encodes an event cursor as an opaque, base64url JSON token. The data is not
 * secret — it is a deterministic continuation token.
 */
export function encodeEventCursor(sequence: number, eventId: MemoryEventId): string {
  const payload: EventCursorPayload = { s: sequence, e: eventId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes and validates an opaque event cursor. Invalid or malformed cursors
 * throw a {@link MemoryValidationError} — never silently ignored (spec §12).
 */
export function decodeEventCursor(cursor: string): EventCursorPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (cause) {
    throw new MemoryValidationError('Malformed event cursor', {
      code: 'INVALID_EVENT_CURSOR',
      cause,
    });
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new MemoryValidationError('Malformed event cursor', {
      code: 'INVALID_EVENT_CURSOR',
    });
  }
  const payload = raw as Record<string, unknown>;
  for (const field of EVENT_CURSOR_SHAPE) {
    if (!(field in payload)) {
      throw new MemoryValidationError('Malformed event cursor', {
        code: 'INVALID_EVENT_CURSOR',
      });
    }
  }
  const s = payload.s;
  const e = payload.e;
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || typeof e !== 'string') {
    throw new MemoryValidationError('Malformed event cursor', {
      code: 'INVALID_EVENT_CURSOR',
    });
  }
  return { s, e };
}

/** Returns true when an event matches the given filter (spec §11). */
export function eventMatchesFilter(event: StoredMemoryEvent, filter: EventLogFilter): boolean {
  if (filter.type !== undefined && event.type !== filter.type) {
    return false;
  }
  if (filter.eventTypes !== undefined && !filter.eventTypes.includes(event.type)) {
    return false;
  }
  if (filter.memoryId !== undefined && event.memoryId !== filter.memoryId) {
    return false;
  }
  if (filter.namespace !== undefined && event.namespace !== filter.namespace) {
    return false;
  }
  if (filter.key !== undefined && event.key !== filter.key) {
    return false;
  }
  if (filter.actorId !== undefined && event.actorId !== filter.actorId) {
    return false;
  }
  if (filter.organizationId !== undefined && event.organizationId !== filter.organizationId) {
    return false;
  }
  if (filter.workspaceId !== undefined && event.workspaceId !== filter.workspaceId) {
    return false;
  }
  if (filter.projectId !== undefined && event.projectId !== filter.projectId) {
    return false;
  }
  if (filter.traceId !== undefined && event.traceId !== filter.traceId) {
    return false;
  }
  if (filter.requestId !== undefined && event.requestId !== filter.requestId) {
    return false;
  }
  if (filter.correlationId !== undefined && event.correlationId !== filter.correlationId) {
    return false;
  }
  if (filter.severity !== undefined && event.severity !== filter.severity) {
    return false;
  }
  if (filter.category !== undefined && event.category !== filter.category) {
    return false;
  }
  if (filter.from !== undefined && event.occurredAt < filter.from) {
    return false;
  }
  if (filter.to !== undefined && event.occurredAt > filter.to) {
    return false;
  }
  if (filter.version !== undefined && event.version !== filter.version) {
    return false;
  }
  if (filter.lifecycleState !== undefined && event.newState !== filter.lifecycleState) {
    return false;
  }
  return true;
}

/**
 * Deterministically compares two stored events: monotonic `sequence` first,
 * then the globally-unique `eventId` as a stable tiebreaker. This guarantees
 * the same ordering for the same stored events regardless of equal timestamps.
 */
export function compareStoredEvents(a: StoredMemoryEvent, b: StoredMemoryEvent): number {
  if (a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }
  return a.eventId.localeCompare(b.eventId);
}

/** Validates a cursor decoded from a prior page (fails closed). */
export function eventAfterCursor(event: StoredMemoryEvent, cursor: EventCursorPayload): boolean {
  if (event.sequence !== cursor.s) {
    return event.sequence > cursor.s;
  }
  return event.eventId.localeCompare(cursor.e) > 0;
}
