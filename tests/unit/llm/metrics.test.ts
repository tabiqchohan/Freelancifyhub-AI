import { describe, expect, it } from 'vitest';

import { LLMMetrics } from '../../../src/llm/metrics/index.js';

describe('LLMMetrics', () => {
  it('starts empty', () => {
    const metrics = new LLMMetrics();
    const snapshot = metrics.snapshot();
    expect(snapshot.totals.requests).toBe(0);
    expect(snapshot.byProvider).toEqual({});
  });

  it('accumulates per-provider counters and aggregates', () => {
    const metrics = new LLMMetrics();
    metrics.record({
      providerId: 'mock',
      model: 'm',
      outcome: 'success',
      durationMs: 10,
      inputTokens: 3,
      outputTokens: 1,
    });
    metrics.record({
      providerId: 'mock',
      model: 'm',
      outcome: 'timeout',
      durationMs: 500,
      retries: 2,
    });
    metrics.record({
      providerId: 'http',
      model: 'gpt',
      outcome: 'validation_failure',
      durationMs: 20,
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.totals.requests).toBe(3);
    expect(snapshot.totals.successes).toBe(1);
    expect(snapshot.totals.timeouts).toBe(1);
    expect(snapshot.totals.validationFailures).toBe(1);
    expect(snapshot.totals.failures).toBe(1);
    expect(snapshot.totals.retries).toBe(2);
    expect(snapshot.totals.inputTokens).toBe(3);
    expect(snapshot.totals.outputTokens).toBe(1);

    const mock = snapshot.byProvider['mock']!;
    expect(mock.totalDurationMs).toBe(510);
    expect(mock.counters.requests).toBe(2);
    expect(mock.lastDurationMs).toBe(500);
  });

  it('keys providers deterministically and never by request id', () => {
    const metrics = new LLMMetrics();
    metrics.record({ providerId: 'mock', model: 'm', outcome: 'success', durationMs: 1 });
    const keys = Object.keys(metrics.snapshot().byProvider);
    expect(keys).toEqual(['mock']);
  });
});
