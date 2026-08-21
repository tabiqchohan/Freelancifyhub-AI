import { describe, expect, it } from 'vitest';

import {
  MemoryLifecycleState,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import {
  DefaultMemoryRetentionEvaluator,
  MemoryRetentionDecision,
  computeExpiry,
  isMemoryExpired,
} from '../../../../src/agents/ag-002-memory-manager/retention/index.js';
import { makeRecord } from './fixtures.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const PAST = '2026-03-01T00:00:00.000Z';

describe('TTL mechanics (E - prompt §7)', () => {
  it('computes an expiry from createdAt + ttl', () => {
    expect(computeExpiry('2026-01-01T00:00:00.000Z', 86_400_000)).toBe('2026-01-02T00:00:00.000Z');
  });

  it('returns undefined when no TTL applies', () => {
    expect(computeExpiry('2026-01-01T00:00:00.000Z', 0)).toBeUndefined();
    expect(computeExpiry('2026-01-01T00:00:00.000Z', undefined)).toBeUndefined();
  });

  it('is not expired without an expiresAt', () => {
    expect(isMemoryExpired(makeRecord(), NOW)).toBe(false);
  });

  it('treats expiresAt equal to now as expired (boundary)', () => {
    expect(isMemoryExpired(makeRecord({ expiresAt: NOW.toISOString() }), NOW)).toBe(true);
  });

  it('is expired only once the window has closed', () => {
    expect(isMemoryExpired(makeRecord({ expiresAt: PAST }), NOW)).toBe(true);
    expect(isMemoryExpired(makeRecord({ expiresAt: '2027-01-01T00:00:00.000Z' }), NOW)).toBe(false);
  });
});

describe('Retention evaluation (F/G - prompt §9, §10)', () => {
  const evaluator = new DefaultMemoryRetentionEvaluator();

  it('keeps a live, non-expired record', () => {
    const evaluation = evaluator.evaluate(makeRecord(), NOW);
    expect(evaluation.decision).toBe(MemoryRetentionDecision.KEEP);
    expect(evaluation.expired).toBe(false);
  });

  it('keeps a deleted record (terminal)', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({ lifecycle: MemoryLifecycleState.Deleted, expiresAt: PAST }),
      NOW,
    );
    expect(evaluation.decision).toBe(MemoryRetentionDecision.KEEP);
    expect(evaluation.reason).toContain('terminal');
  });

  it('keeps an archived record (legal hold)', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({ lifecycle: MemoryLifecycleState.Archived, expiresAt: PAST }),
      NOW,
    );
    expect(evaluation.decision).toBe(MemoryRetentionDecision.KEEP);
    expect(evaluation.reason).toContain('legal hold');
  });

  it('archives an expired conversation (rolling_window)', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({
        type: MemoryType.Conversation,
        retention: { kind: 'rolling_window' },
        expiresAt: PAST,
      }),
      NOW,
    );
    expect(evaluation.decision).toBe(MemoryRetentionDecision.ARCHIVE);
    expect(evaluation.expired).toBe(true);
  });

  it('deletes an expired temporary record', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({ type: MemoryType.Temporary, retention: { kind: 'none' }, expiresAt: PAST }),
      NOW,
    );
    expect(evaluation.decision).toBe(MemoryRetentionDecision.DELETE);
  });

  it('deletes an expired session record', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({ type: MemoryType.Session, retention: { kind: 'none' }, expiresAt: PAST }),
      NOW,
    );
    expect(evaluation.decision).toBe(MemoryRetentionDecision.DELETE);
  });

  it('marks an expired generic record as EXPIRE (fallback)', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({ type: MemoryType.User, retention: { kind: 'until_deletion' }, expiresAt: PAST }),
      NOW,
    );
    expect(evaluation.decision).toBe(MemoryRetentionDecision.EXPIRE);
  });

  it('degrades unknown retention kinds to the conservative EXPIRE', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({ type: MemoryType.User, retention: { kind: 'invalidation' }, expiresAt: PAST }),
      NOW,
    );
    expect(evaluation.decision).toBe(MemoryRetentionDecision.EXPIRE);
  });

  it('keeps an already-expired generic record (no-op loop guard)', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({
        type: MemoryType.User,
        retention: { kind: 'until_deletion' },
        expiresAt: PAST,
        lifecycle: MemoryLifecycleState.Expired,
      }),
      NOW,
    );
    expect(evaluation.decision).toBe(MemoryRetentionDecision.KEEP);
    expect(evaluation.reason).toContain('already expired');
  });

  it('still archives an expired conversation that is in the EXPIRED state', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({
        type: MemoryType.Conversation,
        retention: { kind: 'rolling_window' },
        expiresAt: PAST,
        lifecycle: MemoryLifecycleState.Expired,
      }),
      NOW,
    );
    expect(evaluation.decision).toBe(MemoryRetentionDecision.ARCHIVE);
  });

  it('never leaks content or secrets in the evaluation', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({
        type: MemoryType.Conversation,
        content: { apiKey: 'super-secret', text: 'hello' },
        metadata: { token: 'secret' },
        expiresAt: PAST,
      }),
      NOW,
    );
    expect('content' in evaluation).toBe(false);
    expect('metadata' in evaluation.details).toBe(false);
    expect(JSON.stringify(evaluation)).not.toContain('super-secret');
    expect(JSON.stringify(evaluation)).not.toContain('secret');
  });

  it('carries safe structured details', () => {
    const evaluation = evaluator.evaluate(
      makeRecord({ type: MemoryType.Conversation, expiresAt: PAST }),
      NOW,
    );
    expect(evaluation.details).toMatchObject({
      namespace: 'user:1',
      type: MemoryType.Conversation,
      lifecycle: MemoryLifecycleState.Active,
    });
  });
});
