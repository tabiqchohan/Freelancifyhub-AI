import { ExecutionCancelledError } from '../errors/index.js';

/** A thread-safe cancellation token/controller (prompt §14). */
export class CancellationController {
  private cancelled = false;
  private reason?: string;
  private readonly waiters = new Set<() => void>();

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get cancellationReason(): string | undefined {
    return this.reason;
  }

  /** Cancels the execution. Idempotent: subsequent calls are ignored. */
  cancel(reason = 'cancelled'): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    this.reason = reason;

    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.clear();
  }

  /** Resolves when cancellation is requested. Rejects otherwise via a sentinel. */
  waitForCancellation(): Promise<void> {
    if (this.cancelled) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.add(resolve);
    });
  }

  /** Throws if cancellation has been requested. */
  throwIfCancelled(): void {
    if (this.cancelled) {
      throw new ExecutionCancelledError(`Execution cancelled: ${this.reason ?? 'unknown reason'}`, {
        details: { reason: this.reason },
      });
    }
  }

  /** Factory for the structured cancellation error. */
  cancellationError(): ExecutionCancelledError {
    return new ExecutionCancelledError(`Execution cancelled: ${this.reason ?? 'unknown reason'}`, {
      details: { reason: this.reason },
    });
  }
}
