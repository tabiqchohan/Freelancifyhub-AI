import { describe, expect, it } from 'vitest';

import {
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import { MemoryLifecycleTransitionError } from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import {
  DefaultMemoryLifecycle,
  transitionMemoryRecord,
} from '../../../../src/agents/ag-002-memory-manager/lifecycle/index.js';
import { makeOwner, makeRecord } from './fixtures.js';

const S = MemoryLifecycleState;

describe('transitionMemoryRecord - lifecycle manager (prompt §3, §8, §14)', () => {
  it('returns a new record with the target lifecycle and a bumped version', () => {
    const record = makeRecord({ lifecycle: S.Active, version: 1 });
    const result = transitionMemoryRecord(
      record,
      S.Expired,
      '2026-06-01T00:00:00.000Z',
      'trace_test',
      'TTL exceeded',
    );
    expect(result.from).toBe(S.Active);
    expect(result.to).toBe(S.Expired);
    expect(result.version).toBe(2);
    expect(result.record.lifecycle).toBe(S.Expired);
    expect(result.record.version).toBe(2);
  });

  it('never mutates the input record', () => {
    const record = makeRecord({ lifecycle: S.Active, version: 1 });
    const snapshot = { ...record, lifecycle: record.lifecycle, version: record.version };
    transitionMemoryRecord(
      record,
      S.Archived,
      '2026-06-01T00:00:00.000Z',
      'trace_test',
      'archived',
    );
    expect(record).toEqual(snapshot);
  });

  it('preserves identity, ownership, security and content across transitions', () => {
    const record = makeRecord({
      type: MemoryType.Conversation,
      owner: makeOwner(MemoryOwnerKind.User, '42'),
      securityLevel: MemorySecurityLevel.Confidential,
      content: { text: 'hello' },
      metadata: { a: 1 },
    });
    const result = transitionMemoryRecord(
      record,
      S.Archived,
      '2026-06-01T00:00:00.000Z',
      'trace_test',
      'retention',
    );
    expect(result.record.id).toBe(record.id);
    expect(result.record.namespace).toBe(record.namespace);
    expect(result.record.key).toBe(record.key);
    expect(result.record.type).toBe(record.type);
    expect(result.record.owner).toEqual(record.owner);
    expect(result.record.securityLevel).toBe(record.securityLevel);
    expect(result.record.content).toEqual(record.content);
    expect(result.record.metadata).toEqual(record.metadata);
  });

  it('stamps the transition instant, reason and trace id on the result', () => {
    const result = transitionMemoryRecord(
      makeRecord(),
      S.Deleted,
      '2026-06-01T00:00:00.000Z',
      'trace_xyz',
      'dsr request',
    );
    expect(result.at).toBe('2026-06-01T00:00:00.000Z');
    expect(result.record.updatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(result.record.reason).toBe('dsr request');
    expect(result.record.traceId).toBe('trace_xyz');
  });

  it('rejects invalid transitions with a typed error', () => {
    const record = makeRecord({ lifecycle: S.Deleted });
    expect(() =>
      transitionMemoryRecord(record, S.Active, '2026-06-01T00:00:00.000Z', 'trace_test', 'restore'),
    ).toThrow(MemoryLifecycleTransitionError);
  });

  it('accepts an injected lifecycle contract for validation', () => {
    const lenient = new DefaultMemoryLifecycle();
    const result = transitionMemoryRecord(
      makeRecord({ lifecycle: S.Active }),
      S.Archived,
      '2026-06-01T00:00:00.000Z',
      'trace_test',
      'archived',
      lenient,
    );
    expect(result.record.lifecycle).toBe(S.Archived);
  });
});
