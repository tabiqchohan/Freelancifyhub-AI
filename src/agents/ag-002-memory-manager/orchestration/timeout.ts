import { MemoryIntegrationError, MemoryIntegrationErrorCategory } from './error.js';

/**
 * Sprint 8 — bounded execution (prompt §15, §16).
 *
 * Runs an asynchronous memory operation under a real wall-clock time budget so
 * memory can never block the orchestrator indefinitely. The authoritative
 * orchestrator deadline is respected by only ever *shortening* the effective
 * budget, never extending it.
 *
 * Cancellation and timeout are distinct: cancellation honours the caller's
 * signal without waiting; timeout enforces the bounded wall-clock budget.
 */

/** Runs an async op with a bounded wall-clock timeout. */
export async function withTimeout<T>(op: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    throw new MemoryIntegrationError('memory timeout must be positive', {
      category: MemoryIntegrationErrorCategory.Configuration,
    });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new MemoryIntegrationError('memory operation exceeded its time budget', {
            category: MemoryIntegrationErrorCategory.Timeout,
            retryable: true,
          }),
        );
      }, timeoutMs);
      op().then(resolve, reject);
    });
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** True when the caller's cancellation signal is active. */
export function isCancelled(signal: (() => boolean) | undefined): boolean {
  return signal !== undefined && signal();
}
