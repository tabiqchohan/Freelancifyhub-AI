import { describe, expect, it } from 'vitest';

import {
  computeBackoff,
  decideRetry,
} from '../../../../../src/agents/agent-platform/coordination/retry.js';
import type { TaskRetryPolicy } from '../../../../../src/agents/agent-platform/coordination/types.js';

const policy: TaskRetryPolicy = {
  maxRetries: 2,
  retryable: true,
  backoffMs: 100,
  backoffMultiplier: 2,
  maxBackoffMs: 1000,
};

describe('retry policy (Sprint 20 §16)', () => {
  it('schedules retries with capped exponential backoff', () => {
    const first = decideRetry({ policy, failedAttempt: 1, retryable: true });
    expect(first.shouldRetry).toBe(true);
    expect(first.delayMs).toBe(100);

    const second = decideRetry({ policy, failedAttempt: 2, retryable: true });
    expect(second.shouldRetry).toBe(true);
    expect(second.delayMs).toBe(200);
  });

  it('never retries beyond maxRetries', () => {
    const exceeded = decideRetry({ policy, failedAttempt: 3, retryable: true });
    expect(exceeded.shouldRetry).toBe(false);
    expect(exceeded.reason).toContain('maximum retries');
  });

  it('never retries non-retryable errors or disabled policies', () => {
    expect(decideRetry({ policy, failedAttempt: 1, retryable: false }).shouldRetry).toBe(false);
    expect(
      decideRetry({ policy: { ...policy, retryable: false }, failedAttempt: 1, retryable: true })
        .shouldRetry,
    ).toBe(false);
  });

  it('computeBackoff caps at maxBackoffMs', () => {
    expect(computeBackoff(policy, 10)).toBe(1000);
  });
});
