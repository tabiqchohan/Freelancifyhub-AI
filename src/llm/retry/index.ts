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

/**
 * Computes an exponential backoff delay for a retry attempt with bounded
 * jitter (±25%) so concurrent retry storms are spread apart, never exceeding
 * the configured ceiling. The jitter source is injectable so tests stay
 * deterministic (pass a fixed `random`, e.g. `() => 0.5` for exact values).
 */
export function computeBackoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const capped = Math.min(Math.floor(Math.pow(2, attempt) * baseMs), maxMs);
  if (capped <= 0) {
    return 0;
  }
  const jitterRatio = 0.75 + random() * 0.5;
  return Math.min(Math.max(1, Math.floor(capped * jitterRatio)), maxMs);
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
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LLMCancelledError('LLM request cancelled during retry delay'));
    };
    const timer = setTimeout(() => {
      // Sprint 34 — never keep the abort listener attached after a normal
      // delay elapse (previously the listener lived until the signal fired
      // or was GC'd, leaking a closure per backoff window).
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
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
  let onAbort: (() => void) | undefined;

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
          onAbort = (): void => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              timer = undefined;
              resolve({ outcome: 'cancelled' });
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });

  return Promise.race([run, timedOut, cancelled]).then((outcome) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // Sprint 34 — detach the abort listener once the attempt has settled so a
    // long-lived signal does not keep a closure per attempt alive.
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
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

/**
 * Prompts15 Phase 3 — per-attempt budget handed to the guarded attempt so the
 * provider's own abort timer is clamped to the same value the guard uses.
 * Without this the guard would abandon a fetch that kept running past the
 * deadline, leaving the connection open.
 */
export interface LLMAttemptBudget {
  readonly timeoutMs: number;
}

/** Options for {@link generateWithRetry}. */
export interface GenerateWithRetryOptions {
  readonly retries: LLMRetryConfig;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Injectable sleep for deterministic tests (default: cancellable timeout). */
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  readonly onRetry?: LLMRetryObserver;
  /**
   * Prompts15 Phase 3 — absolute deadline (epoch ms) covering every attempt and
   * backoff window. `timeoutMs` then becomes a per-attempt ceiling rather than
   * the total budget. When omitted the behaviour is unchanged (total budget =
   * `timeoutMs` per attempt, retries bounded only by `maxRetries`).
   */
  readonly deadlineAt?: number;
  /** Injectable clock for deterministic deadline tests. */
  readonly now?: () => number;
}

/**
 * Runs an attempt with timeout + cancellation and bounded, classification-aware
 * retries. Permanent failures (auth/invalid/validation/cancelled) are rethrown
 * immediately; transient failures (network/rate-limit/provider-5xx/timeout) are
 * retried with exponential backoff up to `maxRetries`. Cancellation during
 * backoff aborts with {@link LLMCancelledError}. Returns the first successful
 * value or rethrows the final classified {@link LLMError}.
 *
 * Prompts15 Phase 3/4 — when `deadlineAt` is set the whole chain is bounded:
 * a new attempt is never started after the deadline, each attempt's timeout is
 * clamped to the remaining budget, and a backoff that cannot fit before the
 * deadline fails immediately instead of sleeping into it. Caller cancellation
 * still wins over the deadline whenever it fires first.
 */
export async function generateWithRetry<T>(
  attempt: (budget: LLMAttemptBudget) => Promise<T>,
  options: GenerateWithRetryOptions,
): Promise<T> {
  const { retries, timeoutMs, signal } = options;
  const sleep = options.sleep ?? cancellableDelay;
  const now = options.now ?? Date.now;
  const deadlineAt = options.deadlineAt;

  let lastError: unknown | undefined;

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    // Caller cancellation is checked first so a disconnect is never reported as
    // a deadline timeout (Prompts15 Phase 4).
    if (signal !== undefined && signal.aborted) {
      throw new LLMCancelledError('LLM request cancelled');
    }

    const remaining = deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - now());
    if (remaining !== undefined && remaining <= 0) {
      throw new LLMTimeoutError('LLM request exceeded its deadline before another attempt', {
        details: { deadlineAt },
        cause: lastError,
      });
    }

    // Per-attempt ceiling = configured timeout clamped to the remaining budget.
    const effectiveTimeoutMs =
      remaining === undefined ? timeoutMs : Math.max(1, Math.min(timeoutMs, remaining));

    const outcome = await runGuardedAttempt(
      () => attempt({ timeoutMs: effectiveTimeoutMs }),
      effectiveTimeoutMs,
      signal,
    );

    if (outcome.outcome === 'ok') {
      return outcome.value;
    }

    if (outcome.outcome === 'cancelled') {
      throw new LLMCancelledError('LLM request cancelled');
    }

    let error: unknown;
    if (outcome.outcome === 'timeout') {
      error = new LLMTimeoutError(`LLM request exceeded ${effectiveTimeoutMs}ms timeout`, {
        details: { timeoutMs: effectiveTimeoutMs },
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
    const budgetAfterBackoff = deadlineAt === undefined ? undefined : deadlineAt - now();
    // Prompts15 Phase 3 — never sleep past the deadline; the chain ends here.
    if (budgetAfterBackoff !== undefined && delayMs >= budgetAfterBackoff) {
      throw new LLMTimeoutError('LLM request exceeded its deadline during retry backoff', {
        details: { deadlineAt, delayMs },
        cause: error,
      });
    }
    options.onRetry?.({ attempt: attemptNumber, delayMs, error });
    await sleep(delayMs, signal);
  }

  throw lastError as LLMError;
}
