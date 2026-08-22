import type { MemoryActorGroup, MemoryLifecycleState } from '../enums/index.js';
import type {
  IsoTimestamp,
  MemoryId,
  MemoryKey,
  MemoryNamespace,
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
  Retrieved = 'MEMORY_RETRIEVED',
  Summarized = 'MEMORY_SUMMARIZED',
  // Sprint 3: Security audit events
  AccessAllowed = 'MEMORY_ACCESS_ALLOWED',
  AccessDenied = 'MEMORY_ACCESS_DENIED',
  ReadDenied = 'MEMORY_READ_DENIED',
  WriteDenied = 'MEMORY_WRITE_DENIED',
  UpdateDenied = 'MEMORY_UPDATE_DENIED',
  DeleteDenied = 'MEMORY_DELETE_DENIED',
  ArchiveDenied = 'MEMORY_ARCHIVE_DENIED',
}

/** A single, correlated memory event. Never carries content. */
export interface MemoryEvent {
  readonly type: MemoryEventType;
  readonly traceId: TraceId;
  readonly occurredAt: IsoTimestamp;
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
