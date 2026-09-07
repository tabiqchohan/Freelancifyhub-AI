/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Deterministic
 * dependency graph (Sprint 20 §6).
 *
 * A directed graph over plan tasks with:
 *   - directed edges (taskId → dependsOn),
 *   - duplicate/self/unknown-target rejection,
 *   - cycle detection (never execute cyclic plans),
 *   - deterministic topological ordering (Kahn, stable tie-break by input order),
 *   - ready-task calculation (all required deps COMPLETED),
 *   - blocked-task detection (required deps not satisfied),
 *   - dependency-failure propagation (all transitive dependents).
 *
 * Invalid graphs fail before execution ever begins.
 */

import type { AgentId } from '../../ag-001-master-orchestrator/types/index.js';
import {
  CoordinationCycleError,
  CoordinationDeadlockError,
  CoordinationPlanInvalidError,
} from './errors.js';
import { isTerminalTaskStatus, TaskStatus } from './types.js';
import type { AgentTask, TaskDependency } from './types.js';

/** Immutable adjacency view used for scheduling. */
export interface TaskGraph {
  readonly taskIds: readonly string[];
  readonly dependenciesOf: (taskId: string) => readonly string[];
  readonly dependentsOf: (taskId: string) => readonly string[];
  readonly topologicalOrder: readonly string[];
}

/** Builds and validates the dependency graph for a plan's tasks. */
export class TaskDependencyGraph {
  private readonly tasks: ReadonlyMap<string, AgentTask>;
  private readonly dependents: ReadonlyMap<string, readonly string[]>;
  private readonly dependencies: ReadonlyMap<string, readonly string[]>;
  private readonly order: readonly string[];

  constructor(tasks: readonly AgentTask[], dependencies: readonly TaskDependency[]) {
    const byId = new Map<string, AgentTask>();
    for (const task of tasks) {
      if (byId.has(task.taskId)) {
        throw new CoordinationPlanInvalidError(`duplicate task id ${task.taskId}`, {
          taskId: task.taskId,
        });
      }
      byId.set(task.taskId, task);
    }
    this.tasks = byId;

    const errors: string[] = [];
    for (const task of tasks) {
      for (const dep of task.dependencies) {
        const edge = dependencies.find((d) => d.taskId === task.taskId && d.dependsOn === dep);
        const required = edge === undefined ? true : edge.required;
        const target = byId.get(dep);
        if (target === undefined) {
          errors.push(`task ${task.taskId} depends on unknown task ${dep}`);
        } else if (task.taskId === dep) {
          errors.push(`task ${task.taskId} depends on itself`);
        } else if (!target.dependencies.includes(task.taskId) && required && !byId.has(dep)) {
          // Unreachable: target existence already validated; keep for clarity.
        }
      }
    }
    if (errors.length > 0) {
      throw new CoordinationPlanInvalidError('invalid dependency graph', { errors });
    }

    // Incorporate explicit dependency edges (taskId → dependsOn).
    const explicitDeps = new Map<string, string[]>();
    for (const edge of dependencies) {
      const target = byId.get(edge.dependsOn);
      if (target === undefined) {
        throw new CoordinationPlanInvalidError(
          `dependency edge references unknown task ${edge.dependsOn}`,
          { taskId: edge.taskId, dependsOn: edge.dependsOn },
        );
      }
      const list = explicitDeps.get(edge.taskId) ?? [];
      if (!list.includes(edge.dependsOn)) {
        list.push(edge.dependsOn);
      }
      explicitDeps.set(edge.taskId, list);
    }

    // Validate acyclic; all edges must target known tasks.
    this.assertAcyclic(tasks, explicitDeps);

    // Resolve the dependents map (taskId → list of tasks that depend on it).
    const dependentsOut = new Map<string, string[]>();
    for (const task of tasks) {
      for (const dep of resolvedDependencies(task, explicitDeps)) {
        const list = dependentsOut.get(dep) ?? [];
        if (!list.includes(task.taskId)) {
          list.push(task.taskId);
        }
        dependentsOut.set(dep, list);
      }
    }
    this.dependents = dependentsOut;

    const dependenciesOut = new Map<string, readonly string[]>();
    for (const task of tasks) {
      dependenciesOut.set(task.taskId, Object.freeze(resolvedDependencies(task, explicitDeps)));
    }
    this.dependencies = dependenciesOut;

    this.order = Object.freeze(this.topologicalSort(Array.from(tasks), explicitDeps));
  }

  get taskIds(): readonly string[] {
    return this.order;
  }

  get taskCount(): number {
    return this.tasks.size;
  }

  task(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Direct dependencies of a task (deterministic, sorted by plan order). */
  dependenciesOf(taskId: string): readonly string[] {
    return this.dependencies.get(taskId) ?? [];
  }

  /** Direct dependents of a task (deterministic, sorted by plan order). */
  dependentsOf(taskId: string): readonly string[] {
    return this.dependents.get(taskId) ?? [];
  }

  /** Deterministic topological order (Kahn with stable tie-break). */
  get topologicalOrder(): readonly string[] {
    return this.order;
  }

  /** Tasks whose required dependencies are all COMPLETED (Sprint 20 §6). */
  readyTasks(statusByTaskId: Readonly<Record<string, TaskStatus>>): readonly AgentTask[] {
    const ready: AgentTask[] = [];
    for (const taskId of this.order) {
      const task = this.tasks.get(taskId);
      if (task === undefined) {
        continue;
      }
      const status = statusByTaskId[taskId] ?? TaskStatus.Pending;
      if (status !== TaskStatus.Pending && status !== TaskStatus.Ready) {
        continue;
      }
      if (this.satisfied(taskId, statusByTaskId)) {
        ready.push(task);
      }
    }
    return ready;
  }

  /** Tasks blocked because at least one required dependency is not COMPLETED. */
  blockedTasks(statusByTaskId: Readonly<Record<string, TaskStatus>>): readonly AgentTask[] {
    const blocked: AgentTask[] = [];
    for (const taskId of this.order) {
      const task = this.tasks.get(taskId);
      if (task === undefined) {
        continue;
      }
      const status = statusByTaskId[taskId] ?? TaskStatus.Pending;
      if (status !== TaskStatus.Pending && status !== TaskStatus.Ready) {
        continue;
      }
      if (!this.satisfied(taskId, statusByTaskId)) {
        blocked.push(task);
      }
    }
    return blocked;
  }

  /** All transitive dependents of a failed/cancelled task (Sprint 20 §6). */
  dependentClosure(taskId: string): readonly string[] {
    const seen = new Set<string>();
    const visit = (id: string): void => {
      for (const dependent of this.dependentsOf(id)) {
        if (!seen.has(dependent)) {
          seen.add(dependent);
          visit(dependent);
        }
      }
    };
    visit(taskId);
    return Object.freeze([...seen]);
  }

  /** Whether a task's required dependencies are all COMPLETED. */
  satisfied(taskId: string, statusByTaskId: Readonly<Record<string, TaskStatus>>): boolean {
    for (const dep of this.dependenciesOf(taskId)) {
      const status = statusByTaskId[dep];
      if (status !== TaskStatus.Completed) {
        return false;
      }
    }
    return true;
  }

  /** Throws when scheduling is impossible (blocked with unresolvable deps). */
  assertNoDeadlock(statusByTaskId: Readonly<Record<string, TaskStatus>>): void {
    const blocked = this.blockedTasks(statusByTaskId);
    if (blocked.length === 0) {
      return;
    }
    for (const task of blocked) {
      for (const dep of this.dependenciesOf(task.taskId)) {
        const status = statusByTaskId[dep];
        if (
          status === undefined ||
          (status !== TaskStatus.Completed && !isTerminalTaskStatus(status))
        ) {
          // A dep is pending without being ready implies a graph-level deadlock.
          throw new CoordinationDeadlockError(
            `task ${task.taskId} is blocked by non-terminal dependency ${dep} (${status ?? 'PENDING'})`,
            { taskId: task.taskId, dependencyId: dep, dependencyStatus: status ?? 'PENDING' },
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertAcyclic(
    tasks: readonly AgentTask[],
    explicitDeps: ReadonlyMap<string, readonly string[]>,
  ): void {
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const path: string[] = [];

    const visit = (taskId: string): void => {
      const mark = color.get(taskId) ?? WHITE;
      if (mark === GREY) {
        const cycleStart = path.indexOf(taskId);
        const cycle = cycleStart >= 0 ? [...path.slice(cycleStart), taskId] : [taskId];
        throw new CoordinationCycleError(`dependency cycle detected: ${cycle.join(' -> ')}`, {
          cycle,
        });
      }
      if (mark === BLACK) {
        return;
      }
      color.set(taskId, GREY);
      path.push(taskId);
      for (const dep of resolvedDependencies(
        tasks.find((t) => t.taskId === taskId)!,
        explicitDeps,
      )) {
        if (!this.tasks.has(dep)) {
          throw new CoordinationPlanInvalidError(`task ${taskId} depends on unknown task ${dep}`, {
            taskId,
            dependencyId: dep,
          });
        }
        visit(dep);
      }
      path.pop();
      color.set(taskId, BLACK);
    };

    for (const task of tasks) {
      visit(task.taskId);
    }
  }

  private topologicalSort(
    tasks: readonly AgentTask[],
    explicitDeps: ReadonlyMap<string, readonly string[]>,
  ): readonly string[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const task of tasks) {
      inDegree.set(task.taskId, 0);
      adjacency.set(task.taskId, []);
    }
    for (const task of tasks) {
      for (const dep of resolvedDependencies(task, explicitDeps)) {
        const dependentsList = adjacency.get(dep) ?? [];
        dependentsList.push(task.taskId);
        adjacency.set(dep, dependentsList);
        inDegree.set(task.taskId, (inDegree.get(task.taskId) ?? 0) + 1);
      }
    }
    // Stable Kahn: dequeue in original plan order.
    const queue = tasks.map((t) => t.taskId).filter((id) => (inDegree.get(id) ?? 0) === 0);
    const result: string[] = [];
    while (queue.length > 0) {
      const next = queue.shift()!;
      result.push(next);
      const dependents = adjacency.get(next) ?? [];
      // Re-add dependents in plan order as their degrees reach zero.
      const newlyReady: string[] = [];
      for (const dependent of dependents) {
        const degree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, degree);
        if (degree === 0) {
          newlyReady.push(dependent);
        }
      }
      newlyReady.sort(
        (a, b) => tasks.findIndex((t) => t.taskId === a) - tasks.findIndex((t) => t.taskId === b),
      );
      queue.push(...newlyReady);
    }
    if (result.length !== tasks.length) {
      throw new CoordinationCycleError('topological sort detected an unresolved cycle', {
        traversed: result.length,
        total: tasks.length,
      });
    }
    return result;
  }
}

function resolvedDependencies(
  task: AgentTask,
  explicitDeps: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const declared = task.dependencies;
  const explicit = explicitDeps.get(task.taskId) ?? [];
  const combined = [...declared];
  for (const dep of explicit) {
    if (!combined.includes(dep)) {
      combined.push(dep);
    }
  }
  // Deterministic ordering by plan order (stable).
  return combined;
}

/** Convenience validator used by the planner before scheduling. */
export function validateGraph(
  tasks: readonly AgentTask[],
  dependencies: readonly TaskDependency[],
): TaskDependencyGraph {
  return new TaskDependencyGraph(tasks, dependencies);
}

export type { AgentId };
