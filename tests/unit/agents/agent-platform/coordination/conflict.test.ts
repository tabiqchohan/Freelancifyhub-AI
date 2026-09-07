import { describe, expect, it } from 'vitest';

import {
  detectConflicts,
  resolveConflicts,
  throwIfConflictsFail,
} from '../../../../../src/agents/agent-platform/coordination/conflict.js';
import { CoordinationConflictError } from '../../../../../src/agents/agent-platform/coordination/errors.js';
import {
  ConflictPolicy,
  CoordinationMode,
  TaskFailurePolicy,
  TaskStatus,
  AggregationStrategy,
} from '../../../../../src/agents/agent-platform/coordination/types.js';
import type {
  CoordinationPlan,
  TaskResult,
} from '../../../../../src/agents/agent-platform/coordination/types.js';
import { makeDefinition } from './fakes.js';
import type { ConflictDetectionInput } from '../../../../../src/agents/agent-platform/coordination/conflict.js';

function plan(overrides: Partial<CoordinationPlan> = {}): CoordinationPlan {
  const definition = makeDefinition('AG-200');
  const task = (taskId: string, objective: string, dependencies: readonly string[] = []) => ({
    taskId,
    agentId: definition.agentId,
    coordinationId: 'coord_1',
    objective,
    input: {},
    dependencies,
    requiredCapabilities: [],
    requiredTools: [],
    priority: 0,
    timeoutMs: 5000,
    retry: { maxRetries: 0, retryable: false, backoffMs: 0, backoffMultiplier: 1, maxBackoffMs: 0 },
    status: TaskStatus.Pending,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  return {
    coordinationId: 'coord_1',
    mode: CoordinationMode.Parallel,
    tasks: [task('t1', 'same'), task('t2', 'same'), task('t3', 'dep-t3', ['t1'])],
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
  output: unknown,
  status: TaskStatus = TaskStatus.Completed,
): TaskResult {
  return {
    taskId,
    agentId: 'AG-200',
    status,
    output,
    errors: [],
    timing: { durationMs: 1 },
  };
}

function input(
  results: TaskResult[],
  overrides: Partial<CoordinationPlan> = {},
): ConflictDetectionInput {
  return {
    plan: plan(overrides),
    results,
    statusByTaskId: Object.fromEntries(results.map((r) => [r.taskId, r.status])),
  };
}

describe('conflict detection + resolution (Sprint 20 §14)', () => {
  it('detects duplicate results for the same agent + objective', () => {
    const conflicts = detectConflicts(input([result('t1', 'x'), result('t2', 'x')]));
    expect(conflicts.some((c) => c.type === 'duplicate_results')).toBe(true);
  });

  it('detects contradictory outputs under identical objectives', () => {
    const conflicts = detectConflicts(input([result('t1', { a: 1 }), result('t2', { a: 2 })]));
    expect(conflicts.some((c) => c.type === 'contradictory_outputs')).toBe(true);
  });

  it('detects incompatible statuses under REQUIRE_ALL', () => {
    const conflicts = detectConflicts(
      input([result('t1', 'x'), result('t2', 'y', TaskStatus.Failed)], {
        failurePolicy: TaskFailurePolicy.RequireAll,
      }),
    );
    expect(conflicts.some((c) => c.type === 'incompatible_statuses')).toBe(true);
  });

  it('detects agent disagreement in DEBATE', () => {
    const conflicts = detectConflicts(
      input([result('t1', 'a'), result('t2', 'b')], { mode: CoordinationMode.Debate }),
    );
    expect(conflicts.some((c) => c.type === 'agent_disagreement')).toBe(true);
  });

  it('detects missing dependency output', () => {
    const conflicts = detectConflicts(input([result('t3', 'z')]));
    expect(conflicts.some((c) => c.type === 'missing_dependency_output')).toBe(true);
  });

  it('returns continue when no conflicts exist', () => {
    const resolution = resolveConflicts(plan(), [], [result('t1', 'x'), result('t2', 'y')]);
    expect(resolution.decision).toBe('continue');
  });

  it('PRIORITY policy selects the highest priority completed task', () => {
    const resolution = resolveConflicts(
      plan({
        conflictPolicy: ConflictPolicy.Priority,
        tasks: [...plan().tasks.map((t) => (t.taskId === 't1' ? { ...t, priority: 5 } : t))],
      }),
      [detectConflicts(input([result('t1', 'a'), result('t2', 'b')]))[0]!],
      [result('t1', 'a'), result('t2', 'b')],
    );
    expect(resolution.decision).toBe('continue');
    expect(resolution.selectedTaskId).toBe('t1');
  });

  it('FIRST_SUCCESS picks the earliest task in plan order', () => {
    const resolution = resolveConflicts(
      plan({ conflictPolicy: ConflictPolicy.FirstSuccess }),
      [detectConflicts(input([result('t1', 'a'), result('t2', 'b')]))[0]!],
      [result('t1', 'a'), result('t2', 'b')],
    );
    expect(resolution.selectedTaskId).toBe('t1');
  });

  it('REVIEW_REQUIRED flags review', () => {
    const resolution = resolveConflicts(
      plan({ conflictPolicy: ConflictPolicy.ReviewRequired }),
      [detectConflicts(input([result('t1', 'a'), result('t2', 'b')]))[0]!],
      [result('t1', 'a'), result('t2', 'b')],
    );
    expect(resolution.decision).toBe('review_required');
  });

  it('FAIL_ON_CONFLICT fails and throws', () => {
    const resolution = resolveConflicts(
      plan({ conflictPolicy: ConflictPolicy.FailOnConflict }),
      [detectConflicts(input([result('t1', 'a'), result('t2', 'b')]))[0]!],
      [result('t1', 'a'), result('t2', 'b')],
    );
    expect(resolution.decision).toBe('fail');
    expect(() => throwIfConflictsFail(resolution)).toThrow(CoordinationConflictError);
  });
});
