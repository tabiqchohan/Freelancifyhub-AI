import { ExecutionConfigError } from '../errors/index.js';

/**
 * Lightweight in-process semaphore that bounds the number of concurrently
 * running tasks. Used to enforce EXECUTION_MAX_CONCURRENT_STEPS without a
 * worker queue (prompt §7/§21).
 */
export class ConcurrencyLimiter {
  private readonly limit: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ExecutionConfigError(
        `Concurrency limit must be a positive integer, got ${String(limit)}`,
      );
    }
    this.limit = limit;
  }

  /** Runs the task once a concurrency slot is free. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.active -= 1;
      return;
    }
    next();
  }
}
