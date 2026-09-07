/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Coordinator-owned
 * retry policy (Sprint 20 §16).
 *
 * The coordinator owns retries — the underlying executor is always invoked
 * with `maxRetries: 0` and the coordination's per-task timings. Retry
 * decisions are deterministic: bounded by `maxRetries`, only retryable
 * errors, with exponential backoff capped at `maxBackoffMs`. Errors that
 * never retry (timeouts, authorization, deadlocks) short-circuit immediately.
 */

import type { TaskRetryPolicy } from './types.js';

export type { TaskRetryPolicy };

/** Terminal decision for a failed task. */
export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly attempt: number;
  readonly retryable: boolean;
  readonly delayMs: number;
  readonly reason: string;
}

/** Reads the retryable flag from an execution failure. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.name === 'ExecutionError' ||
      error.message.startsWith('task failed') ||
      error.message.toLowerCase().includes('retryable')
    );
  }
  return false;
}

/** Computes the backoff delay after `failedAttempt` attempts (1-based). */
export function computeBackoff(policy: TaskRetryPolicy, failedAttempt: number): number {
  const exponent = Math.max(0, failedAttempt - 1);
  const raw = policy.backoffMs * Math.pow(policy.backoffMultiplier, exponent);
  return Math.min(policy.maxBackoffMs, Math.floor(raw));
}

/** Decides whether a task should be retried after a failure. */
export function decideRetry(options: {
  readonly policy: TaskRetryPolicy;
  readonly failedAttempt: number;
  readonly retryable: boolean;
}): RetryDecision {
  const { policy, failedAttempt, retryable } = options;
  if (!policy.retryable || !retryable) {
    return {
      shouldRetry: false,
      attempt: failedAttempt,
      retryable,
      delayMs: 0,
      reason: retryable ? 'retry disabled by policy' : 'error is not retryable',
    };
  }
  if (failedAttempt > policy.maxRetries) {
    return {
      shouldRetry: false,
      attempt: failedAttempt,
      retryable,
      delayMs: 0,
      reason: 'maximum retries exceeded',
    };
  }
  return {
    shouldRetry: true,
    attempt: failedAttempt,
    retryable,
    delayMs: computeBackoff(policy, failedAttempt),
    reason: `scheduling retry ${failedAttempt} of ${policy.maxRetries}`,
  };
}

/** Applies a retry delay until a cancellation signal fires. */
export async function waitForBackoff(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new Error('coordination cancelled while backing off');
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  });
  if (signal?.aborted) {
    throw new Error('coordination cancelled while backing off');
  }
}
