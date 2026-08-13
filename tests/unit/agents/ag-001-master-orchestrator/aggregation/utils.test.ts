import { describe, expect, it } from 'vitest';

import {
  DeterministicResultOrderer,
  DefaultResultGrouper,
  sanitizeRecord,
  isSensitiveKey,
  RESULT_GROUP_ORDER,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/utils/index.js';
import { ResultGroup } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { makeMultiStepPlan } from './fixtures.js';

const orderer = new DeterministicResultOrderer();
const grouper = new DefaultResultGrouper();

function normalized(overrides: Record<string, unknown>) {
  return {
    executionId: 'exec-1',
    planId: 'plan-1',
    agentId: 'AG-101',
    order: 1,
    status: ExecutionStatus.Succeeded,
    group: ResultGroup.Successful,
    warnings: [],
    attemptCount: 1,
    metadata: {},
    key: 'exec-1:step-x',
    ...overrides,
  } as never;
}

describe('isSensitiveKey / sanitizeRecord', () => {
  it('detects sensitive keys', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('api_key')).toBe(true);
    expect(isSensitiveKey('AUTHORIZATION')).toBe(true);
    expect(isSensitiveKey('sessionId')).toBe(true);
    expect(isSensitiveKey('description')).toBe(false);
    expect(isSensitiveKey('result')).toBe(false);
  });

  it('strips sensitive keys deeply without mutating the input', () => {
    const input = {
      result: 'ok',
      config: {
        apiKey: 'secret',
        username: 'alice',
      },
      headers: [{ token: 'abc' }],
    };
    const cleaned = sanitizeRecord(input);
    expect(cleaned).toEqual({
      result: 'ok',
      config: { username: 'alice' },
      headers: [{}],
    });
    expect(input.config).toEqual({ apiKey: 'secret', username: 'alice' });
  });

  it('leaves scalars untouched', () => {
    expect(sanitizeRecord('hello')).toBe('hello');
    expect(sanitizeRecord(42)).toBe(42);
    expect(sanitizeRecord(null)).toBe(null);
    expect(sanitizeRecord(undefined)).toBe(undefined);
  });
});

describe('DeterministicResultOrderer', () => {
  it('orders by plan step position', () => {
    const plan = makeMultiStepPlan();
    const results = [
      normalized({ stepId: plan.steps[2]!.stepId, order: 1 }),
      normalized({ stepId: plan.steps[0]!.stepId, order: 1 }),
      normalized({ stepId: plan.steps[1]!.stepId, order: 1 }),
    ];
    const ordered = orderer.order(results, plan);
    expect(ordered.map((r) => r.stepId)).toEqual([
      plan.steps[0]!.stepId,
      plan.steps[1]!.stepId,
      plan.steps[2]!.stepId,
    ]);
  });

  it('falls back to step order when no plan position exists', () => {
    const results = [normalized({ stepId: 'b', order: 2 }), normalized({ stepId: 'a', order: 1 })];
    const ordered = orderer.order(results);
    expect(ordered.map((r) => r.stepId)).toEqual(['a', 'b']);
  });

  it('uses startedAt as a further tie-breaker', () => {
    const results = [
      normalized({ stepId: 'a', order: 1, startedAt: '2026-08-13T10:00:02.000Z' }),
      normalized({ stepId: 'b', order: 1, startedAt: '2026-08-13T10:00:01.000Z' }),
    ];
    const ordered = orderer.order(results);
    expect(ordered.map((r) => r.stepId)).toEqual(['b', 'a']);
  });

  it('never mutates the input array', () => {
    const results = [normalized({ stepId: 'b', order: 2 }), normalized({ stepId: 'a', order: 1 })];
    const copy = [...results];
    orderer.order(results);
    expect(results).toEqual(copy);
  });
});

describe('DefaultResultGrouper', () => {
  it('groups results by group', () => {
    const results = [
      normalized({ stepId: 'a', group: ResultGroup.Successful }),
      normalized({ stepId: 'b', group: ResultGroup.Failed }),
      normalized({ stepId: 'c', group: ResultGroup.Successful }),
    ];
    const grouped = grouper.group(results);
    expect(grouped[ResultGroup.Successful]).toHaveLength(2);
    expect(grouped[ResultGroup.Failed]).toHaveLength(1);
  });
});

describe('RESULT_GROUP_ORDER', () => {
  it('covers every group in a stable order', () => {
    const groups = Object.values(ResultGroup);
    expect(new Set(RESULT_GROUP_ORDER)).toEqual(new Set(groups));
  });
});
