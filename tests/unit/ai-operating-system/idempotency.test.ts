import { describe, expect, it } from 'vitest';

import { AggregationStatus } from '../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import { AiosErrorCode } from '../../../src/ai-operating-system/errors.js';
import { AiosIdempotencyRegistry } from '../../../src/ai-operating-system/idempotency.js';
import { AiosStage, type AiosResponse } from '../../../src/ai-operating-system/types.js';

function response(requestId: string): AiosResponse {
  return {
    requestId,
    traceId: `trace-${requestId}`,
    status: AggregationStatus.Success,
    intent: 'project.create',
    response: 'done',
    stages: [AiosStage.Completed],
    execution: {
      target: { kind: 'client' },
      route: {
        intentId: 'project.create',
        supportedAgents: ['AG-101'],
        confidence: 1,
        target: { kind: 'client' },
      },
      intent: { primary: {} } as never,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      agents: ['AG-101'],
    },
  };
}

describe('AIOS idempotency registry (Sprint 26)', () => {
  it('claims a fresh key and replays the completed response for the same request', () => {
    const registry = new AiosIdempotencyRegistry(60_000);
    expect(registry.claim('k-1', 'req-1')).toEqual({ outcome: 'new' });
    registry.complete('k-1', response('req-1'));
    const replay = registry.claim('k-1', 'req-1');
    expect(replay).toEqual({ outcome: 'replay', response: response('req-1') });
  });

  it('flags an in-flight conflict for a different requestId and throws at the boundary', () => {
    const registry = new AiosIdempotencyRegistry(60_000);
    registry.claim('k-2', 'req-a');
    expect(registry.claim('k-2', 'req-b')).toEqual({
      outcome: 'conflict',
      existingRequestId: 'req-a',
    });
    expect(() => registry.throwConflict('req-a', 'k-2')).toThrow(
      expect.objectContaining({ code: AiosErrorCode.IdempotencyConflict }),
    );
  });

  it('expires stale entries after the configured window', () => {
    const registry = new AiosIdempotencyRegistry(1_000);
    const now = 1_000_000;
    expect(registry.claim('k-3', 'req-1', now)).toEqual({ outcome: 'new' });
    expect(registry.claim('k-3', 'req-2', now + 500)).toEqual({
      outcome: 'conflict',
      existingRequestId: 'req-1',
    });
    expect(registry.claim('k-3', 'req-2', now + 2_000)).toEqual({ outcome: 'new' });
  });

  it('never overwrites an expired completed entry with a stale response', () => {
    const registry = new AiosIdempotencyRegistry(1_000);
    const now = 1_000_000;
    registry.claim('k-4', 'req-1', now);
    registry.complete('k-4', response('req-1'), now + 2_000);
    const again = registry.claim('k-4', 'req-1', now + 5_000);
    expect(again.outcome).toBe('new');
  });
});
