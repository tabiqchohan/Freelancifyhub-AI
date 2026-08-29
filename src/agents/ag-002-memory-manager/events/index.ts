import type { MemoryActorGroup, MemoryLifecycleState } from '../enums/index.js';
import type {
  IsoTimestamp,
  MemoryId,
  MemoryJsonValue,
  MemoryKey,
  MemoryNamespace,
  RequestId,
  TraceId,
} from '../types/index.js';

/**
 * Memory lifecycle events (spec §16). The six canonical events come straight
 * from the architecture table; `MEMORY_ACTIVATED` and `MEMORY_EXPIRED` are
 * Sprint 2 extensions that make the operational lifecycle observable (the
 * architecture references activation and TTL expiry but does not name events
 * for them).
 *
 * Sprint 3 adds security audit events for authorization decisions.
 */
export enum MemoryEventType {
  Created = 'MEMORY_CREATED',
  Activated = 'MEMORY_ACTIVATED',
  Updated = 'MEMORY_UPDATED',
  Expired = 'MEMORY_EXPIRED',
  Archived = 'MEMORY_ARCHIVED',
  Deleted = 'MEMORY_DELETED',
  Restored = 'MEMORY_RESTORED',
  Erased = 'MEMORY_ERASED',
  Retrieved = 'MEMORY_RETRIEVED',
  Summarized = 'MEMORY_SUMMARIZED',
  // Sprint 5B: Memory consolidation event
  MemoryConsolidated = 'MEMORY_CONSOLIDATED',
  // Sprint 3: Security audit events
  AccessAllowed = 'MEMORY_ACCESS_ALLOWED',
  AccessDenied = 'MEMORY_ACCESS_DENIED',
  ReadDenied = 'MEMORY_READ_DENIED',
  WriteDenied = 'MEMORY_WRITE_DENIED',
  UpdateDenied = 'MEMORY_UPDATE_DENIED',
  DeleteDenied = 'MEMORY_DELETE_DENIED',
  ArchiveDenied = 'MEMORY_ARCHIVE_DENIED',
  // Sprint 9: Restore / erasure denial events
  RestoreDenied = 'MEMORY_RESTORE_DENIED',
  EraseDenied = 'MEMORY_ERASE_DENIED',
}

/**
 * Sprint 7 — canonical, transport-agnostic scalar types for the event log /
 * audit trail. These are additive and do not change the existing emit surface.
 */

/** Unique identifier of a stored audit event. */
export type MemoryEventId = string;

/** Provenance of an audit event (canonical mapping to the emitting subsystem). */
export type MemoryEventSource =
  'memory' | 'lifecycle' | 'security' | 'retrieval' | 'consolidation' | 'system';

/** Categorical severity used for audit classification (Sprint 7). */
export type MemoryEventSeverity = 'info' | 'warning' | 'critical';

/** Coarse event category for querying (Sprint 7). */
export type MemoryEventCategory =
  'memory' | 'lifecycle' | 'security' | 'retrieval' | 'consolidation' | 'system';

/** A single, correlated memory event. Never carries content. */
export interface MemoryEvent {
  /** Canonical, unique event identifier (Sprint 7). Populated by the log. */
  readonly eventId?: MemoryEventId;
  readonly type: MemoryEventType;
  readonly traceId: TraceId;
  readonly occurredAt: IsoTimestamp;
  /** Canonical timestamp alias for `occurredAt` (Sprint 7). */
  readonly timestamp?: IsoTimestamp;
  readonly namespace: MemoryNamespace;
  readonly key: MemoryKey;
  /** Record id when the event refers to a stored record. */
  readonly memoryId?: MemoryId;
  readonly actorGroup?: MemoryActorGroup;
  readonly version?: number;
  readonly previousVersion?: number;
  /** Lifecycle state before the transition (Sprint 2). */
  readonly previousState?: MemoryLifecycleState;
  /** Lifecycle state after the transition (Sprint 2). */
  readonly newState?: MemoryLifecycleState;
  readonly reason?: string;
  readonly hard?: boolean;
  /** Archive identifier for archival events. */
  readonly archiveId?: string;
  /** Number of results for retrieval events. */
  readonly count?: number;
  /** Sprint 3: Security audit fields. */
  readonly permission?: string;
  readonly targetType?: string;
  readonly targetSecurityLevel?: string;
  readonly denialReason?: string;
  readonly denialCode?: string;
  readonly actorId?: string;
  readonly actorType?: string;
  /** Sprint 5B: Consolidation correlation id. */
  readonly consolidationId?: string;
  /** Sprint 5B: Safe source memory ids that were consolidated. */
  readonly sourceIds?: readonly MemoryId[];
  /** Sprint 5B: Id of the consolidated output record. */
  readonly outputId?: MemoryId;
  /** Sprint 5B: Number of candidate records in the group. */
  readonly candidateGroupSize?: number;
  /** Sprint 7: Canonical correlation metadata (additive, non-breaking). */
  readonly requestId?: RequestId;
  readonly correlationId?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly source?: MemoryEventSource;
  readonly service?: string;
  readonly severity?: MemoryEventSeverity;
  readonly category?: MemoryEventCategory;
  /** Sprint 7: sanitized, content-free event metadata. Never raw content. */
  readonly metadata?: Readonly<Record<string, MemoryJsonValue>>;
}

/** Emits correlated memory events without coupling to a sink (spec §21). */
export interface MemoryEventEmitter {
  readonly name: string;
  emit(event: MemoryEvent): void;
  on(handler: (event: MemoryEvent) => void): () => void;
}

/** Deterministic in-memory event emitter used by tests and local callers. */
export class InMemoryMemoryEventEmitter implements MemoryEventEmitter {
  readonly name = 'in-memory-memory-events';

  private readonly handlers = new Set<(event: MemoryEvent) => void>();
  private readonly recorded: MemoryEvent[] = [];

  emit(event: MemoryEvent): void {
    this.recorded.push(event);
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  on(handler: (event: MemoryEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  list(): readonly MemoryEvent[] {
    return [...this.recorded];
  }

  clear(): void {
    this.recorded.length = 0;
  }
}

export * from './model.js';
export * from './validation.js';
export * from './query.js';
export * from './log.js';
export * from './sanitize.js';
