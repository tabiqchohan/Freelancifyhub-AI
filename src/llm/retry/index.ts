/**
 * Sprint 17 — LLM retry + timeout handling.
 *
 * Robust but bounded: configurable max retries, exponential backoff with a
 * bounded ceiling, AbortSignal-aware waiting, and timeout-aware attempts. Never
 * retries permanent failures (auth/invalid-request/validation/cancellation) and
 * never retries after cancellation. Sleep is injectable so tests never depend
 * on real durations.
 */

import { LLMCancelledError, LLMTimeoutError, classifyLLMError } from '../errors/index.js';
import type { LLMError } from '../errors/index.js';

/** Bounded retry configuration. */
export interface LLMRetryConfig {
  /** Retries allowed after the first attempt (total attempts = maxRetries + 1). */
  readonly maxRetries: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
}

/** Computes a deterministic exponential backoff delay for a retry attempt. */
export function computeBackoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const capped = Math.pow(2, attempt) * baseMs;
  return Math.min(Math.floor(capped), maxMs);
}

/**
 * Bounded async delay that aborts early when the signal fires. Rejects with
 * {@link LLMCancelledError} when cancelled before the delay elapses.
 */
export async function cancellableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal !== undefined && signal.aborted) {
    throw new LLMCancelledError('LLM request cancelled before retry delay');
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal === undefined) {
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new LLMCancelledError('LLM request cancelled during retry delay'));
      },
      { once: true },
    );
  });
}

/**
 * Outcome of a single guarded attempt. Never reports false success on timeout:
 * the first of {resolve, timeout, cancellation} wins deterministically.
 */
export type LLMAttemptOutcome<T> =
  | { readonly outcome: 'ok'; readonly value: T }
  | { readonly outcome: 'error'; readonly error: unknown }
  | { readonly outcome: 'timeout' }
  | { readonly outcome: 'cancelled' };

/** Guards one attempt with a timeout and optional cancellation. */
export function runGuardedAttempt<T>(
  attempt: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<LLMAttemptOutcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;

  const run = Promise.resolve()
    .then(() => attempt())
    .then(
      (value): LLMAttemptOutcome<T> => ({ outcome: 'ok', value }),
      (error): LLMAttemptOutcome<T> => ({ outcome: 'error', error }),
    );

  const timedOut = new Promise<LLMAttemptOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        timer = undefined;
        resolve({ outcome: 'timeout' });
      }
    }, timeoutMs);
  });

  const cancelled =
    signal === undefined
      ? new Promise<LLMAttemptOutcome<T>>(() => undefined)
      : new Promise<LLMAttemptOutcome<T>>((resolve) => {
          if (signal.aborted) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve({ outcome: 'cancelled' });
            }
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                timer = undefined;
                resolve({ outcome: 'cancelled' });
              }
            },
            { once: true },
          );
        });

  return Promise.race([run, timedOut, cancelled]).then((outcome) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return outcome;
  });
}

/** Callback invoked before each retry backoff (safe metadata only). */
export type LLMRetryObserver = (info: {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: unknown;
}) => void;

/** Options for {@link generateWithRetry}. */
export interface GenerateWithRetryOptions {
  readonly retries: LLMRetryConfig;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Injectable sleep for deterministic tests (default: cancellable timeout). */
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  readonly onRetry?: LLMRetryObserver;
}

/**
 * Runs an attempt with timeout + cancellation and bounded, classification-aware
 * retries. Permanent failures (auth/invalid/validation/cancelled) are rethrown
 * immediately; transient failures (network/rate-limit/provider-5xx/timeout) are
 * retried with exponential backoff up to `maxRetries`. Cancellation during
 * backoff aborts with {@link LLMCancelledError}. Returns the first successful
 * value or rethrows the final classified {@link LLMError}.
 */
export async function generateWithRetry<T>(
  attempt: () => Promise<T>,
  options: GenerateWithRetryOptions,
): Promise<T> {
  const { retries, timeoutMs, signal } = options;
  const sleep = options.sleep ?? cancellableDelay;

  let lastError: unknown | undefined;

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    if (signal !== undefined && signal.aborted) {
      throw new LLMCancelledError('LLM request cancelled');
    }

    const outcome = await runGuardedAttempt(attempt, timeoutMs, signal);

    if (outcome.outcome === 'ok') {
      return outcome.value;
    }

    if (outcome.outcome === 'cancelled') {
      throw new LLMCancelledError('LLM request cancelled');
    }

    let error: unknown;
    if (outcome.outcome === 'timeout') {
      error = new LLMTimeoutError(`LLM request exceeded ${timeoutMs}ms timeout`, {
        details: { timeoutMs },
      });
    } else {
      error = outcome.error;
    }
    lastError = error;

    const classification = classifyLLMError(error);
    if (!classification.retryable) {
      throw error as LLMError;
    }

    if (attemptNumber > retries.maxRetries) {
      break;
    }

    const delayMs = computeBackoffDelay(attemptNumber, retries.backoffBaseMs, retries.backoffMaxMs);
    options.onRetry?.({ attempt: attemptNumber, delayMs, error });
    await sleep(delayMs, signal);
  }

  throw lastError as LLMError;
}
