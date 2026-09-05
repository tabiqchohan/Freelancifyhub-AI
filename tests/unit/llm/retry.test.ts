import { describe, expect, it, vi } from 'vitest';

import {
  cancellableDelay,
  computeBackoffDelay,
  generateWithRetry,
} from '../../../src/llm/retry/index.js';
import {
  LLMAuthenticationError,
  LLMCancelledError,
  LLMInternalError,
  LLMNetworkError,
  LLMRateLimitError,
  LLMTimeoutError,
} from '../../../src/llm/errors/index.js';

const RETRIES = { maxRetries: 2, backoffBaseMs: 10, backoffMaxMs: 100 };
const AUTH = new LLMAuthenticationError('simulated auth failure');
const NETWORK = new LLMNetworkError('simulated network failure');
const RATE_LIMIT = new LLMRateLimitError('simulated rate limit');
const INTERNAL = new LLMInternalError('simulated internal failure');

const noopSleep = async (): Promise<void> => undefined;

describe('computeBackoffDelay', () => {
  it('grows exponentially but stays bounded', () => {
    expect(computeBackoffDelay(1, 100, 300)).toBe(200);
    expect(computeBackoffDelay(2, 100, 300)).toBe(300);
    expect(computeBackoffDelay(10, 100, 3000)).toBe(3000);
  });
});

describe('generateWithRetry', () => {
  it('succeeds on the first attempt', async () => {
    const attempt = vi.fn(async () => 'ok');
    const onRetry = vi.fn();
    const result = await generateWithRetry(attempt, {
      retries: RETRIES,
      timeoutMs: 1000,
      sleep: noopSleep,
      onRetry,
    });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries a transient failure and succeeds', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(NETWORK).mockResolvedValueOnce('recovered');
    const sleep = vi.fn(noopSleep);
    const onRetry = vi.fn();
    const result = await generateWithRetry(attempt, {
      retries: { ...RETRIES, maxRetries: 3 },
      timeoutMs: 1000,
      sleep,
      onRetry,
    });
    expect(result).toBe('recovered');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    const info = onRetry.mock.calls[0]?.[0];
    expect(info?.attempt).toBe(1);
    expect(info?.delayMs).toBeGreaterThan(0);
  });

  it('stops retrying after max retries are exhausted', async () => {
    const attempt = vi.fn().mockRejectedValue(RATE_LIMIT);
    const onRetry = vi.fn(async () => undefined);
    await expect(
      generateWithRetry(attempt, {
        retries: { ...RETRIES, maxRetries: 2 },
        timeoutMs: 1000,
        sleep: noopSleep,
        onRetry,
      }),
    ).rejects.toBeInstanceOf(LLMRateLimitError);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('never retries permanent failures', async () => {
    const attempt = vi.fn().mockRejectedValue(AUTH);
    const onRetry = vi.fn(async () => undefined);
    await expect(
      generateWithRetry(attempt, {
        retries: RETRIES,
        timeoutMs: 1000,
        sleep: noopSleep,
        onRetry,
      }),
    ).rejects.toBeInstanceOf(LLMAuthenticationError);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();

    const internalAttempt = vi.fn().mockRejectedValue(INTERNAL);
    await expect(
      generateWithRetry(internalAttempt, {
        retries: RETRIES,
        timeoutMs: 1000,
        sleep: noopSleep,
      }),
    ).rejects.toBeInstanceOf(LLMInternalError);
    expect(internalAttempt).toHaveBeenCalledTimes(1);
  });

  it('throws LLMCancelledError on an already-cancelled request without calling the attempt', async () => {
    const attempt = vi.fn(async () => 'never');
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateWithRetry(attempt, {
        retries: RETRIES,
        timeoutMs: 1000,
        signal: controller.signal,
        sleep: noopSleep,
      }),
    ).rejects.toBeInstanceOf(LLMCancelledError);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('aborts during retry backoff with LLMCancelledError', async () => {
    const attempt = vi.fn().mockRejectedValue(NETWORK);
    await expect(
      generateWithRetry(attempt, {
        retries: { ...RETRIES, maxRetries: 3 },
        timeoutMs: 1000,
        sleep: async () => {
          throw new LLMCancelledError('cancelled while waiting for retry');
        },
      }),
    ).rejects.toBeInstanceOf(LLMCancelledError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('throws LLMTimeoutError when an attempt exceeds the timeout', async () => {
    const attempt = vi.fn(() => new Promise<string>(() => undefined));
    await expect(
      generateWithRetry(attempt, {
        retries: { ...RETRIES, maxRetries: 0 },
        timeoutMs: 5,
        sleep: noopSleep,
      }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-LLM thrown values as non-retryable internal outcomes', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(
      generateWithRetry(attempt, {
        retries: { ...RETRIES, maxRetries: 3 },
        timeoutMs: 1000,
        sleep: noopSleep,
      }),
    ).rejects.toThrow('boom');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('cancellableDelay', () => {
  it('rejects immediately on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(cancellableDelay(1000, controller.signal)).rejects.toBeInstanceOf(
      LLMCancelledError,
    );
  });

  it('resolves after the delay when no signal fires', async () => {
    await expect(cancellableDelay(1, undefined)).resolves.toBeUndefined();
  });
});
