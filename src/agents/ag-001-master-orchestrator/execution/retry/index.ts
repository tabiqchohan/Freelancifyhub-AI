import type { ExecutionConfig } from '../config/index.js';
import type { ExecutionError, ExecutionRetry } from '../types/index.js';
import type { ExecutionRetryPolicy } from '../../planning/types/index.js';

/** Computes a deterministic, bounded retry delay (prompt §12). */
export function computeRetryDelay(attempt: number, baseMs: number, maxMs: number): number {
  // Exponential backoff without jitter: base * 2^(attempt-1), bounded by maxMs.
  const delay = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, maxMs);
}

/** Whether an error qualifies for a retry attempt. */
export function isRetryable(error: ExecutionError): boolean {
  return error.retryable === true;
}

/** Builds the retry metadata for an attempt (prompt §12). */
export function buildExecutionRetry(
  stepId: string,
  attempt: number,
  maxAttempts: number,
  error: ExecutionError,
  retryPolicy: ExecutionRetryPolicy,
): ExecutionRetry {
  return {
    stepId,
    attempt,
    maxAttempts,
    delayMs: retryPolicy.backoffMs ?? computeRetryDelay(attempt, 1_000, 30_000),
    error,
  };
}

/** Resolves the effective retry budget for a step (config + step policy). */
export function effectiveMaxAttempts(
  retryPolicy: ExecutionRetryPolicy,
  config: ExecutionConfig,
): number {
  const fromStep = retryPolicy.maxRetries + 1;
  const fromConfig = config.EXECUTION_MAX_RETRY_ATTEMPTS;
  return Math.min(fromStep, fromConfig);
}

/** Whether another attempt is allowed for the given error. */
export function shouldRetry(
  error: ExecutionError,
  attempt: number,
  maxAttempts: number,
  retryable: boolean,
): boolean {
  return attempt < maxAttempts && retryable && isRetryable(error);
}

export type { ExecutionRetry };
