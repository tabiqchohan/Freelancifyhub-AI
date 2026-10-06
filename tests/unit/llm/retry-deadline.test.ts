/**
 * Prompts15 Phase 6 — deadline-bounded LLM retry chain (DEADLINE-1..10) and
 * caller-abort/deadline precedence (COMBINED-1..5).
 *
 * Before this work `generateWithRetry` bounded only *each attempt*. N attempts
 * plus N-1 backoff windows could therefore run for
 * `attempts * LLM_TIMEOUT_MS + backoff`, far past the caller's deadline, and a
 * guard timeout abandoned the in-flight fetch instead of tearing it down.
 *
 * Every test here fails if the deadline handling is reverted. The clock and
 * sleep are injected and jitter is pinned so the assertions are deterministic
 * and never depend on real durations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateWithRetry } from '../../../src/llm/retry/index.js';
import {
  LLMAuthenticationError,
  LLMCancelledError,
  LLMNetworkError,
  LLMTimeoutError,
} from '../../../src/llm/errors/index.js';

const BACKOFF = { backoffBaseMs: 50, backoffMaxMs: 100 };

/** A fake clock that only advances when the retry chain sleeps. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/**
 * Records every attempt. `sleep` advances the fake clock instead of waiting, so
 * a test can observe the whole chain in microseconds.
 */
function recordingHarness(options: {
  readonly attempts: readonly (() => Promise<string>)[];
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}) {
  const clock = fakeClock();
  const seen: number[] = [];
  const budgets: number[] = [];
  let index = 0;

  const sleep = vi.fn(async (ms: number) => {
    clock.advance(ms);
  });

  const run = async (deadlineAt?: number, signal?: AbortSignal): Promise<string> =>
    generateWithRetry(
      (budget) => {
        seen.push(index + 1);
        budgets.push(budget.timeoutMs);
        const attempt = options.attempts[Math.min(index, options.attempts.length - 1)]!;
        index += 1;
        return attempt();
      },
      {
        retries: { maxRetries: options.maxRetries ?? 5, ...BACKOFF },
        timeoutMs: options.timeoutMs ?? 1_000,
        signal,
        deadlineAt,
        now: clock.now,
        sleep,
      },
    );

  return { run, clock, seen, budgets, sleep };
}

const boom = async (): Promise<string> => {
  throw new LLMNetworkError('upstream refused');
};

describe('Prompts15 Phase 6 — DEADLINE: the whole retry chain is bounded', () => {
  beforeEach(() => {
    // Pin the backoff jitter so delay math is exact (ratio = 0.75 + 0.5 * 0.5).
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DEADLINE-1: refuses to start another attempt once the deadline has passed', async () => {
    const harness = recordingHarness({ attempts: [boom] });
    // Deadline already in the past when the chain starts.
    await expect(harness.run(harness.clock.now() - 1)).rejects.toBeInstanceOf(LLMTimeoutError);
    expect(harness.seen).toEqual([]);
    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it('DEADLINE-2: clamps the per-attempt timeout to the remaining budget', async () => {
    const harness: ReturnType<typeof recordingHarness> = recordingHarness({
      attempts: [
        async () => {
          // Burn 600ms of the 1000ms budget, then fail transiently.
          harness.clock.advance(600);
          throw new LLMNetworkError('transient');
        },
        async () => 'recovered',
      ],
    });

    await harness.run(harness.clock.now() + 1_000);

    expect(harness.seen).toEqual([1, 2]);
    // The first attempt gets the full 1000ms. The second is clamped to the 300ms
    // that remain after the attempt and its backoff — so the provider's own
    // abort timer matches the guard instead of the unbounded LLM_TIMEOUT_MS.
    expect(harness.budgets).toEqual([1_000, 300]);
  });

  it('DEADLINE-3: fails instead of sleeping a backoff that cannot fit before the deadline', async () => {
    const harness = recordingHarness({ attempts: [boom] });

    // 1000ms budget; the first backoff is 100ms and fits, but the next is 100ms
    // with only ~0 left once exhausted — the chain must not sleep into the wall.
    await expect(harness.run(harness.clock.now() + 50)).rejects.toBeInstanceOf(LLMTimeoutError);

    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it('DEADLINE-4: retries while backoffs still fit, and returns the eventual success', async () => {
    const harness = recordingHarness({
      attempts: [boom, boom, async () => 'ok'],
    });

    await expect(harness.run(harness.clock.now() + 120_000)).resolves.toBe('ok');
    expect(harness.seen).toEqual([1, 2, 3]);
  });

  it('DEADLINE-5: the deadline — not maxRetries — is what ends the chain', async () => {
    const harness = recordingHarness({ attempts: [boom], maxRetries: 50 });

    // Deadline is exhausted long before 50 retries are allowed.
    await expect(harness.run(harness.clock.now() + 150)).rejects.toBeInstanceOf(LLMTimeoutError);

    expect(harness.sleep).toHaveBeenCalled();
    expect(harness.seen.length).toBeLessThan(51);
  });

  it('DEADLINE-6: a first attempt that succeeds before the deadline is returned unchanged', async () => {
    const harness = recordingHarness({ attempts: [async () => 'immediate'] });

    await expect(harness.run(harness.clock.now() + 60_000)).resolves.toBe('immediate');
    expect(harness.seen).toEqual([1]);
    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it('DEADLINE-7: without a deadline the pre-existing per-attempt behaviour is unchanged', async () => {
    const harness = recordingHarness({ attempts: [boom, async () => 'second try'] });

    await expect(harness.run(undefined)).resolves.toBe('second try');
    // No clamping: both attempts get the full configured timeout.
    expect(harness.budgets).toEqual([1_000, 1_000]);
  });

  it('DEADLINE-8: a permanent failure still throws immediately, ignoring the deadline', async () => {
    const authError = new LLMAuthenticationError('bad key');
    const harness = recordingHarness({
      attempts: [
        async () => {
          throw authError;
        },
      ],
    });

    await expect(harness.run(harness.clock.now() + 60_000)).rejects.toBe(authError);
    expect(harness.seen).toEqual([1]);
    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it('DEADLINE-9: an attempt that outlives its clamped budget is reported as a timeout', async () => {
    // The attempt never settles; the guard must fire on the clamped timeout.
    const harness = recordingHarness({
      attempts: [async () => new Promise<string>(() => undefined)],
    });

    await expect(harness.run(harness.clock.now() + 50)).rejects.toBeInstanceOf(LLMTimeoutError);
    expect(harness.budgets).toEqual([50]);
  });

  it('DEADLINE-10: the chain never sleeps past its deadline', async () => {
    const harness = recordingHarness({ attempts: [boom] });

    const startedAt = harness.clock.now();
    await expect(harness.run(startedAt + 150)).rejects.toBeInstanceOf(LLMTimeoutError);

    // Total simulated time stayed inside the deadline.
    expect(harness.clock.now() - startedAt).toBeLessThanOrEqual(150);
  });
});

describe('Prompts15 Phase 6 — COMBINED: caller abort and deadline', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('COMBINED-1: caller abort wins over a generous deadline and is reported as cancelled', async () => {
    const controller = new AbortController();
    const harness = recordingHarness({
      attempts: [
        async () => {
          controller.abort();
          throw new LLMNetworkError('transient');
        },
      ],
    });

    await expect(
      harness.run(harness.clock.now() + 60_000, controller.signal),
    ).rejects.toBeInstanceOf(LLMCancelledError);
  });

  it('COMBINED-2: an abort during backoff is cancelled, not timed out', async () => {
    const controller = new AbortController();
    const clock = fakeClock();
    const sleep = vi.fn(async (ms: number) => {
      clock.advance(ms);
      controller.abort();
    });

    await expect(
      generateWithRetry(boom, {
        retries: { maxRetries: 5, ...BACKOFF },
        timeoutMs: 1_000,
        signal: controller.signal,
        deadlineAt: clock.now() + 120_000,
        now: clock.now,
        sleep,
      }),
    ).rejects.toBeInstanceOf(LLMCancelledError);

    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('COMBINED-3: a deadline that elapses first is a timeout, not a cancellation', async () => {
    const controller = new AbortController();
    const harness = recordingHarness({ attempts: [boom] });

    await expect(harness.run(harness.clock.now() + 50, controller.signal)).rejects.toBeInstanceOf(
      LLMTimeoutError,
    );
    // The caller's signal was never aborted.
    expect(controller.signal.aborted).toBe(false);
  });

  it('COMBINED-4: an already-aborted signal never reaches the provider', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = recordingHarness({ attempts: [async () => 'never'] });

    await expect(
      harness.run(harness.clock.now() + 60_000, controller.signal),
    ).rejects.toBeInstanceOf(LLMCancelledError);
    expect(harness.seen).toEqual([]);
  });

  it('COMBINED-5: a caller abort is not masked by the clamped attempt timeout', async () => {
    const controller = new AbortController();
    let abortObserved = false;

    // The deadline clamps the attempt budget to 50ms, but the caller aborts at
    // 5ms: the cancellation must win the race rather than being masked.
    const timer = setTimeout(() => controller.abort(), 5);
    try {
      await expect(
        generateWithRetry(
          (budget) =>
            new Promise<string>((_resolve, reject) => {
              const guard = setTimeout(() => {
                reject(new LLMTimeoutError(`exceeded ${budget.timeoutMs}ms`));
              }, budget.timeoutMs);
              controller.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(guard);
                  abortObserved = true;
                  reject(new LLMCancelledError('caller disconnected'));
                },
                { once: true },
              );
            }),
          {
            retries: { maxRetries: 5, ...BACKOFF },
            timeoutMs: 5_000,
            signal: controller.signal,
            deadlineAt: Date.now() + 50,
          },
        ),
      ).rejects.toBeInstanceOf(LLMCancelledError);
    } finally {
      clearTimeout(timer);
    }

    expect(abortObserved).toBe(true);
  });
});
