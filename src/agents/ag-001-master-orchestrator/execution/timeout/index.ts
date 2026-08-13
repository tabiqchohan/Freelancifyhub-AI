import { ExecutionTimeoutError } from '../errors/index.js';

/** Applies a step/overall timeout to a promise (prompt §13). */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ExecutionTimeoutError(message, { details: { timeoutMs } }));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/** A deadline whose promise resolves when the elapsed time is exceeded. */
export function createDeadline(timeoutMs: number): {
  readonly promise: Promise<void>;
  readonly clear: () => void;
} {
  let resolve: (() => void) | undefined;
  const timer = setTimeout(() => {
    resolve?.();
  }, timeoutMs);

  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    clear: () => clearTimeout(timer),
  };
}
