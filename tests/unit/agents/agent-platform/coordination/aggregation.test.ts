import { describe, expect, it } from 'vitest';

import {
  aggregateResults,
  deepEqual,
} from '../../../../../src/agents/agent-platform/coordination/aggregation.js';
import {
  AggregationStrategy,
  ConflictPolicy,
  TaskFailurePolicy,
  TaskStatus,
} from '../../../../../src/agents/agent-platform/coordination/types.js';
import type {
  CoordinationPlan,
  TaskResult,
  ConflictRecord,
} from '../../../../../src/agents/agent-platform/coordination/types.js';
import { makeDefinition } from './fakes.js';

function plan(overrides: Partial<CoordinationPlan> = {}): CoordinationPlan {
  const definition = makeDefinition('AG-200');
  return {
    coordinationId: 'coord_1',
    mode: 'PARALLEL' as CoordinationPlan['mode'],
    tasks: [
      {
        taskId: 't1',
        agentId: definition.agentId,
        coordinationId: 'coord_1',
        objective: 'one',
        input: {},
        dependencies: [],
        requiredCapabilities: [],
        requiredTools: [],
        priority: 1,
        timeoutMs: 5000,
        retry: {
          maxRetries: 0,
          retryable: false,
          backoffMs: 0,
          backoffMultiplier: 1,
          maxBackoffMs: 0,
        },
        status: TaskStatus.Pending,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        taskId: 't2',
        agentId: definition.agentId,
        coordinationId: 'coord_1',
        objective: 'two',
        input: {},
        dependencies: [],
        requiredCapabilities: [],
        requiredTools: [],
        priority: 0,
        timeoutMs: 5000,
        retry: {
          maxRetries: 0,
          retryable: false,
          backoffMs: 0,
          backoffMultiplier: 1,
          maxBackoffMs: 0,
        },
        status: TaskStatus.Pending,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    dependencies: [],
    limits: {
      maxTasks: 16,
      maxConcurrentTasks: 4,
      maxTasksPerAgent: 4,
      globalTimeoutMs: 60_000,
      defaultTaskTimeoutMs: 15_000,
      maxMessageBytes: 32_768,
    },
    failurePolicy: TaskFailurePolicy.FailFast,
    conflictPolicy: ConflictPolicy.FailOnConflict,
    aggregation: AggregationStrategy.Collect,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function result(
  taskId: string,
  output: unknown = undefined,
  status: TaskStatus = TaskStatus.Completed,
): TaskResult {
  return {
    taskId,
    agentId: 'AG-200',
    status,
    output,
    errors: [],
    timing: {
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
    },
  };
}

const resolution = { decision: 'continue' as const };
const noConflicts: readonly ConflictRecord[] = [];

describe('aggregateResults (Sprint 20 §13)', () => {
  it('COLLECT keys outputs by task id', () => {
    const aggregate = aggregateResults(
      plan({ aggregation: AggregationStrategy.Collect }),
      [result('t1', { a: 1 }), result('t2', { b: 2 })],
      resolution,
      noConflicts,
    );
    expect(aggregate.output).toEqual({ t1: { a: 1 }, t2: { b: 2 } });
    expect(aggregate.successCount).toBe(2);
    expect(aggregate.mustReview).toBe(false);
  });

  it('MERGE deep-merges structured outputs', () => {
    const aggregate = aggregateResults(
      plan({ aggregation: AggregationStrategy.Merge }),
      [
        result('t1', { project: { name: 'x' } }),
        result('t2', { project: { status: 'active' }, owner: 'me' }),
      ],
      resolution,
      noConflicts,
    );
    expect(aggregate.output).toEqual({ project: { name: 'x', status: 'active' }, owner: 'me' });
  });

  it('BEST_RESULT selects the highest priority completed task', () => {
    const aggregate = aggregateResults(
      plan({ aggregation: AggregationStrategy.BestResult }),
      [result('t1', 'one'), result('t2', 'two')],
      { decision: 'continue', selectedTaskId: 't1' },
      noConflicts,
    );
    expect(aggregate.output).toBe('one');
  });

  it('CONSENSUS returns the majority output and flags review elsewhere', () => {
    const same = aggregateResults(
      plan({ aggregation: AggregationStrategy.Consensus }),
      [result('t1', { v: 1 }), result('t2', { v: 1 })],
      resolution,
      noConflicts,
    );
    expect(same.output).toEqual({ v: 1 });
    expect(same.mustReview).toBe(false);

    const split = aggregateResults(
      plan({ aggregation: AggregationStrategy.Consensus }),
      [result('t1', { v: 1 }), result('t2', { v: 2 })],
      resolution,
      noConflicts,
    );
    expect(split.mustReview).toBe(true);
  });

  it('REVIEW wraps outputs and always flags review', () => {
    const aggregate = aggregateResults(
      plan({ aggregation: AggregationStrategy.Review }),
      [result('t1', 'a'), result('t2', 'b')],
      resolution,
      noConflicts,
    );
    expect(aggregate.mustReview).toBe(true);
    expect(aggregate.output).toEqual({ results: ['a', 'b'] });
  });

  it('counts failures/skips and derives success/failure counts', () => {
    const aggregate = aggregateResults(
      plan({ aggregation: AggregationStrategy.Collect }),
      [
        result('t1', 'a'),
        result('t2', 'b', TaskStatus.Failed),
        result('t3', 'c', TaskStatus.Skipped),
      ],
      resolution,
      noConflicts,
    );
    expect(aggregate.successCount).toBe(1);
    expect(aggregate.failureCount).toBe(1);
    expect(aggregate.skippedCount).toBe(1);
    expect(aggregate.totalCount).toBe(3);
  });

  it('deepEqual compares JSON-safe structures', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
    expect(deepEqual(undefined, null)).toBe(false);
  });
});
