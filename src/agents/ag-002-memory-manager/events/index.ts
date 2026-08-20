import type { MemoryActorGroup } from '../enums/index.js';
import type { IsoTimestamp, MemoryKey, MemoryNamespace, TraceId } from '../types/index.js';

/** Memory lifecycle events defined by the architecture (spec §16). */
export enum MemoryEventType {
  Created = 'MEMORY_CREATED',
  Updated = 'MEMORY_UPDATED',
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
  readonly actorGroup?: MemoryActorGroup;
  readonly version?: number;
  readonly previousVersion?: number;
  readonly reason?: string;
  readonly hard?: boolean;
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
