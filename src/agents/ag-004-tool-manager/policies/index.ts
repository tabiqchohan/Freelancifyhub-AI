import { ToolErrorClass } from '../enums/index.js';
import { ToolTimeoutError, ToolCancellationError, ToolError } from '../errors/index.js';
import type { ToolErrorClassification } from '../types/index.js';

/**
 * AG-004 execution policies: timeout, cancellation, retry, and error
 * classification. Deterministic and cancellation-aware.
 */

/** Classifies a thrown error for retry policy. Never blindly retries auth/validation. */
export function classifyToolError(error: unknown): ToolErrorClassification {
  if (error instanceof ToolTimeoutError) {
    return { errorClass: ToolErrorClass.Timeout, retryable: false };
  }
  if (error instanceof ToolCancellationError) {
    return { errorClass: ToolErrorClass.Cancellation, retryable: false };
  }
  if (error instanceof ToolError) {
    switch (error.code) {
      case 'TOOL_ACCESS_DENIED_ERROR':
      case 'TOOL_AUTHORIZATION_FAILED':
        return { errorClass: ToolErrorClass.Authorization, retryable: false };
      case 'TOOL_VALIDATION_ERROR':
        return { errorClass: ToolErrorClass.Validation, retryable: false };
      default:
        return {
          errorClass: error.retryable ? ToolErrorClass.Retryable : ToolErrorClass.NonRetryable,
          retryable: error.retryable,
        };
    }
  }
  return { errorClass: ToolErrorClass.Internal, retryable: false };
}

/** Returns true when a given error class should be retried. */
export function isRetryableClass(errorClass: ToolErrorClass): boolean {
  return errorClass === ToolErrorClass.Retryable;
}

/** Computes a deterministic (exponential) backoff delay for a retry attempt. */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const capped = Math.pow(2, attempt) * baseMs;
  return Math.min(Math.floor(capped), maxMs);
}

/** Bounded async delay that is cancellation-aware. */
export function cancellableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new ToolCancellationError('Execution cancelled during retry delay'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new ToolCancellationError('Execution cancelled during retry delay'));
        },
        { once: true },
      );
    }
  });
}

/**
 * Runs a tool handler under a timeout + optional cancellation signal and
 * resolves with the winning state. Never reports false success on timeout:
 * the first of {resolve, timeout, cancellation} to fire wins deterministically.
 */
export async function runWithTimeoutAndCancellation<T>(
  executor: () => Promise<T>,
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly onTimeout?: () => void;
    readonly onCancel?: () => void;
  },
): Promise<{ ok: true; value: T } | { ok: false; reason: 'timeout' | 'cancelled' }> {
  const { timeoutMs, signal } = options;

  let timer: NodeJS.Timeout | undefined;
  let settled = false;

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        options.onTimeout?.();
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        resolve('timeout');
      }
    }, timeoutMs);
  });

  const cancellationPromise =
    signal === undefined
      ? new Promise<'cancelled'>(() => undefined)
      : new Promise<'cancelled'>((resolve) => {
          if (signal.aborted) {
            if (!settled) {
              settled = true;
              options.onCancel?.();
              resolve('cancelled');
            }
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              if (!settled) {
                settled = true;
                if (timer !== undefined) {
                  clearTimeout(timer);
                  timer = undefined;
                }
                options.onCancel?.();
                resolve('cancelled');
              }
            },
            { once: true },
          );
        });

  const runPromise = Promise.resolve()
    .then(() => executor())
    .then((value): { outcome: 'ok'; value: T } => ({ outcome: 'ok', value }))
    .catch((error): { outcome: 'error'; error: unknown } => ({ outcome: 'error', error }));

  const result = await Promise.race([runPromise, timeoutPromise, cancellationPromise]);

  if (result === 'timeout') {
    return { ok: false, reason: 'timeout' };
  }
  if (result === 'cancelled') {
    return { ok: false, reason: 'cancelled' };
  }
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (result.outcome === 'ok') {
    return { ok: true, value: result.value };
  }
  throw result.error;
}
