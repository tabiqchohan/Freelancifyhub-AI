import {
  ExecutionCycleError,
  ExecutionDependencyError,
  ExecutionPlanValidationError,
} from '../errors/index.js';
import type { ExecutionDependency, ExecutionStep } from '../types/index.js';

/** A validated dependency graph for a set of steps. */
export interface DependencyGraph {
  readonly steps: readonly ExecutionStep[];
  /** Dependency edges: dependent step id → its prerequisites. */
  readonly edges: ReadonlyMap<string, readonly string[]>;
  /** Steps that have no prerequisites (graph roots). */
  readonly roots: readonly string[];
  /** Deterministic topological order of step ids. */
  readonly order: readonly string[];
  /** Maximum dependency depth (longest path from a root). */
  readonly maximumDepth: number;
}

/** Validates step ids for duplicates and empty values. */
export function validateStepIds(steps: readonly ExecutionStep[]): void {
  const seen = new Set<string>();

  for (const step of steps) {
    if (step.stepId.length === 0) {
      throw new ExecutionPlanValidationError('Execution step id must be a non-empty string');
    }

    if (seen.has(step.stepId)) {
      throw new ExecutionPlanValidationError(`Duplicate execution step id: ${step.stepId}`);
    }

    seen.add(step.stepId);
  }
}

/** Validates a single dependency edge against the known step ids. */
export function validateDependency(
  dependency: ExecutionDependency,
  stepIds: ReadonlySet<string>,
): void {
  if (dependency.stepId.length === 0 || dependency.dependsOn.length === 0) {
    throw new ExecutionDependencyError('Execution dependency ids must be non-empty strings');
  }

  if (dependency.stepId === dependency.dependsOn) {
    throw new ExecutionDependencyError(
      `Execution step ${dependency.stepId} cannot depend on itself`,
    );
  }

  if (!stepIds.has(dependency.stepId)) {
    throw new ExecutionDependencyError(
      `Execution dependency references unknown step: ${dependency.stepId}`,
    );
  }

  if (!stepIds.has(dependency.dependsOn)) {
    throw new ExecutionDependencyError(
      `Execution step ${dependency.stepId} depends on unknown step: ${dependency.dependsOn}`,
    );
  }
}

/**
 * Builds and validates a deterministic dependency graph (prompt §8). Detects
 * duplicate step ids, self dependencies, missing dependencies and circular
 * dependencies via a stable topological sort.
 */
export function buildDependencyGraph(
  steps: readonly ExecutionStep[],
  dependencies: readonly ExecutionDependency[],
): DependencyGraph {
  validateStepIds(steps);

  const stepIds = new Set(steps.map((step) => step.stepId));

  for (const dependency of dependencies) {
    validateDependency(dependency, stepIds);
  }

  const edges = indexDependencies(dependencies);
  const rootSet = new Set(stepIds);

  for (const dependency of dependencies) {
    rootSet.delete(dependency.stepId);
  }

  const order = topologicalSort(dependencies, stepIds);
  const maximumDepth = computeMaximumDepth(order, edges);

  return {
    steps,
    edges,
    roots: [...rootSet].sort(),
    order,
    maximumDepth,
  };
}

/** Groups dependency edges by the dependent step id (its prerequisites). */
function indexDependencies(
  dependencies: readonly ExecutionDependency[],
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();

  for (const dependency of dependencies) {
    const list = index.get(dependency.stepId);
    if (list === undefined) {
      index.set(dependency.stepId, [dependency.dependsOn]);
    } else {
      list.push(dependency.dependsOn);
    }
  }

  return index;
}

/**
 * Deterministic Kahn topological sort. When several nodes are ready the
 * lexicographically smallest step id is taken so the ordering is stable for
 * identical inputs (prompt §8/§11).
 */
function topologicalSort(
  dependencies: readonly ExecutionDependency[],
  stepIds: ReadonlySet<string>,
): readonly string[] {
  const incoming = new Map<string, number>();

  for (const stepId of stepIds) {
    incoming.set(stepId, 0);
  }

  for (const dependency of dependencies) {
    incoming.set(dependency.stepId, (incoming.get(dependency.stepId) ?? 0) + 1);
  }

  const dependents = indexDependents(dependencies);
  const ready = [...stepIds].filter((stepId) => (incoming.get(stepId) ?? 0) === 0).sort();

  const order: string[] = [];

  while (ready.length > 0) {
    const stepId = ready.shift()!;
    order.push(stepId);

    for (const dependent of dependents.get(stepId) ?? []) {
      const count = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, count);

      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== stepIds.size) {
    const cycle = [...stepIds].filter((stepId) => (incoming.get(stepId) ?? 0) > 0).sort();
    throw new ExecutionCycleError(
      `Execution dependency graph contains a cycle involving: ${cycle.join(', ')}`,
      { details: { steps: cycle } },
    );
  }

  return order;
}

/** Reverse edge index: prerequisite step id → steps that depend on it. */
function indexDependents(
  dependencies: readonly ExecutionDependency[],
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();

  for (const dependency of dependencies) {
    const list = index.get(dependency.dependsOn);
    if (list === undefined) {
      index.set(dependency.dependsOn, [dependency.stepId]);
    } else {
      list.push(dependency.stepId);
    }
  }

  return index;
}

/** Longest dependency path from any root (prompt §8). */
function computeMaximumDepth(
  order: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): number {
  const depth = new Map<string, number>();

  for (const stepId of order) {
    const prerequisites = edges.get(stepId) ?? [];
    const parentDepth = prerequisites.reduce(
      (max, parent) => Math.max(max, depth.get(parent) ?? 0),
      0,
    );
    depth.set(stepId, parentDepth + 1);
  }

  return Math.max(0, ...depth.values()) - 1;
}

/** Number of execution stages (topological levels) in the graph. */
export function estimateExecutionStages(
  order: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): number {
  const level = new Map<string, number>();

  for (const stepId of order) {
    const prerequisites = edges.get(stepId) ?? [];
    const parentLevel = prerequisites.reduce(
      (max, parent) => Math.max(max, level.get(parent) ?? 0),
      0,
    );
    level.set(stepId, parentLevel + 1);
  }

  return Math.max(0, ...level.values());
}
