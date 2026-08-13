import type { ExecutionEventEmitter } from '../interfaces/index.js';
import type { ExecutionEvent } from '../types/index.js';

/**
 * In-memory event emitter (prompt §17). Records events in insertion order so
 * they are deterministic per execution. Used by tests and observability; no
 * external broker in this sprint.
 */
export class InMemoryExecutionEventEmitter implements ExecutionEventEmitter {
  private readonly events: ExecutionEvent[] = [];

  emit(event: ExecutionEvent): void {
    this.events.push(event);
  }

  /** Ordered snapshot of all emitted events. */
  all(): readonly ExecutionEvent[] {
    return [...this.events];
  }

  /** Events filtered by type, in emission order. */
  ofType(type: ExecutionEvent['type']): readonly ExecutionEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  clear(): void {
    this.events.length = 0;
  }
}

export type { ExecutionEvent };
