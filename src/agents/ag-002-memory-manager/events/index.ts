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
