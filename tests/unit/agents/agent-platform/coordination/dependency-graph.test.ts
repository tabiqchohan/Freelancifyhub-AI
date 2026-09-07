import { describe, expect, it } from 'vitest';

import {
  CoordinationCycleError,
  CoordinationDeadlockError,
  CoordinationPlanInvalidError,
} from '../../../../../src/agents/agent-platform/coordination/errors.js';
import {
  TaskDependencyGraph,
  validateGraph,
} from '../../../../../src/agents/agent-platform/coordination/dependency-graph.js';
import { TaskStatus } from '../../../../../src/agents/agent-platform/coordination/types.js';
import type {
  AgentTask,
  TaskDependency,
} from '../../../../../src/agents/agent-platform/coordination/types.js';
import { makeDefinition } from './fakes.js';

function task(
  id: string,
  dependencies: readonly string[] = [],
  overrides: Partial<AgentTask> = {},
): AgentTask {
  const definition = makeDefinition('AG-101');
  return {
    taskId: id,
    agentId: definition.agentId,
    coordinationId: 'coord_test',
    objective: `objective ${id}`,
    input: {},
    dependencies: [...dependencies],
    requiredCapabilities: [],
    requiredTools: [],
    priority: 0,
    timeoutMs: 5000,
    retry: { maxRetries: 0, retryable: false, backoffMs: 0, backoffMultiplier: 1, maxBackoffMs: 0 },
    status: TaskStatus.Pending,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function edges(entries: readonly [string, string][]): readonly TaskDependency[] {
  return entries.map(([taskId, dependsOn]) => ({ taskId, dependsOn, required: true }));
}

describe('TaskDependencyGraph (Sprint 20 §6)', () => {
  it('computes deterministic topological order for a chain', () => {
    const graph = new TaskDependencyGraph(
      [task('a'), task('b', ['a']), task('c', ['b'])],
      edges([
        ['b', 'a'],
        ['c', 'b'],
      ]),
    );
    expect(graph.topologicalOrder).toEqual(['a', 'b', 'c']);
  });

  it('orders independent tasks by plan order (stable)', () => {
    const graph = new TaskDependencyGraph([task('x'), task('y')], []);
    expect(graph.topologicalOrder).toEqual(['x', 'y']);
  });

  it('rejects duplicate task ids', () => {
    expect(() => new TaskDependencyGraph([task('a'), task('a')], [])).toThrow(
      CoordinationPlanInvalidError,
    );
  });

  it('rejects cycles', () => {
    expect(
      () =>
        new TaskDependencyGraph(
          [task('a', ['b']), task('b', ['a'])],
          edges([
            ['a', 'b'],
            ['b', 'a'],
          ]),
        ),
    ).toThrow(CoordinationCycleError);
  });

  it('rejects self dependencies', () => {
    expect(() => new TaskDependencyGraph([task('a', ['a'])], edges([['a', 'a']]))).toThrow(
      CoordinationPlanInvalidError,
    );
  });

  it('rejects unknown dependency targets', () => {
    expect(() => new TaskDependencyGraph([task('a', ['ghost'])], edges([['a', 'ghost']]))).toThrow(
      CoordinationPlanInvalidError,
    );
  });

  it('reports ready vs blocked tasks from statuses', () => {
    const graph = new TaskDependencyGraph([task('a'), task('b', ['a'])], edges([['b', 'a']]));
    const statuses = { a: TaskStatus.Completed, b: TaskStatus.Pending };
    expect(graph.readyTasks(statuses).map((t) => t.taskId)).toEqual(['b']);
    // b is blocked while its dependency a is still Pending.
    expect(
      graph.blockedTasks({ a: TaskStatus.Pending, b: TaskStatus.Pending }).map((t) => t.taskId),
    ).toEqual(['b']);
  });

  it('treats a dependency as unsatisfied until COMPLETED', () => {
    const graph = new TaskDependencyGraph([task('a'), task('b', ['a'])], edges([['b', 'a']]));
    expect(graph.satisfied('b', { a: TaskStatus.Running })).toBe(false);
    expect(graph.satisfied('b', { a: TaskStatus.Completed })).toBe(true);
    expect(graph.satisfied('b', { a: TaskStatus.Failed })).toBe(false);
  });

  it('computes transitive dependent closures', () => {
    const graph = new TaskDependencyGraph(
      [task('a'), task('b', ['a']), task('c', ['b']), task('d'), task('e', ['d'])],
      edges([
        ['b', 'a'],
        ['c', 'b'],
        ['e', 'd'],
      ]),
    );
    expect([...graph.dependentClosure('a')].sort()).toEqual(['b', 'c']);
    expect(graph.dependentClosure('d')).toEqual(['e']);
    expect(graph.dependentClosure('x')).toEqual([]);
  });

  it('detects deadlock when a pending task is blocked by a non-terminal non-ready dep', () => {
    const graph = new TaskDependencyGraph([task('a'), task('b', ['a'])], edges([['b', 'a']]));
    expect(() => graph.assertNoDeadlock({ a: TaskStatus.Pending, b: TaskStatus.Pending })).toThrow(
      CoordinationDeadlockError,
    );
  });

  it('validateGraph builds a usable graph', () => {
    const graph = validateGraph([task('a'), task('b', ['a'])], edges([['b', 'a']]));
    expect(graph.taskCount).toBe(2);
    expect(graph.dependenciesOf('b')).toEqual(['a']);
  });
});
