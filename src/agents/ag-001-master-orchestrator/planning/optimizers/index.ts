import type {
  ExecutionBranch,
  ExecutionCondition,
  ExecutionDependency,
  ExecutionStep,
  PlanningWarning,
} from '../types/index.js';
import type { ExecutionPlanOptimizer } from '../interfaces/index.js';

interface PlanFragments {
  readonly steps: readonly ExecutionStep[];
  readonly dependencies: readonly ExecutionDependency[];
  readonly conditions: readonly ExecutionCondition[];
  readonly branches: readonly ExecutionBranch[];
}

/** Structural signature used to detect duplicate steps/metadata. */
function stepSignature(step: ExecutionStep): string {
  return [
    step.agentId,
    step.order,
    step.capabilities.join(','),
    step.input.map((reference) => reference.id).join(','),
    step.output.map((reference) => reference.id).join(','),
    step.policy.failureBehavior,
    step.timeoutMs,
    step.retry.maxRetries,
  ].join('|');
}

function conditionSignature(condition: ExecutionCondition): string {
  return [
    condition.operator,
    condition.field ?? '',
    String(condition.value ?? ''),
    (condition.children ?? []).join(','),
  ].join('|');
}

/**
 * Safe, deterministic plan optimizer (prompt §17). Only applies changes that
 * cannot alter business meaning: removes exact duplicate steps, removes steps
 * that are unreachable from the plan roots, and merges identical condition
 * metadata. Dependency ordering is always preserved.
 */
export class SafePlanOptimizer implements ExecutionPlanOptimizer {
  readonly name = 'safe-plan-optimizer';

  optimize(plan: PlanFragments): {
    readonly steps: readonly ExecutionStep[];
    readonly dependencies: readonly ExecutionDependency[];
    readonly conditions: readonly ExecutionCondition[];
    readonly branches: readonly ExecutionBranch[];
    readonly optimizations: readonly PlanningWarning[];
  } {
    const optimizations: PlanningWarning[] = [];
    let steps: readonly ExecutionStep[] = [...plan.steps];
    let dependencies: readonly ExecutionDependency[] = [...plan.dependencies];

    const deduplicated = removeDuplicateSteps(steps, optimizations);
    steps = deduplicated.steps;

    const reachable = pruneUnreachableSteps(steps, dependencies, optimizations);
    steps = reachable.steps;
    dependencies = removeDanglingDependencies(
      reachable.dependencies,
      new Set(steps.map((step) => step.stepId)),
      optimizations,
    );

    const conditions = deduplicateConditions(plan.conditions, optimizations);
    const branches = removeDanglingBranches(
      plan.branches,
      new Set(steps.map((step) => step.stepId)),
      optimizations,
    );

    return { steps, dependencies, conditions, branches, optimizations };
  }
}

function removeDuplicateSteps(
  steps: readonly ExecutionStep[],
  optimizations: PlanningWarning[],
): { readonly steps: readonly ExecutionStep[] } {
  const seen = new Set<string>();
  const result: ExecutionStep[] = [];

  for (const step of steps) {
    const signature = stepSignature(step);
    if (seen.has(signature)) {
      optimizations.push({
        code: 'DUPLICATE_STEP_REMOVED',
        message: `Removed duplicate step ${step.stepId} for agent ${step.agentId}`,
        stepId: step.stepId,
      });
      continue;
    }
    seen.add(signature);
    result.push(step);
  }

  return { steps: result };
}

function removeDanglingDependencies(
  dependencies: readonly ExecutionDependency[],
  stepIds: ReadonlySet<string>,
  optimizations: PlanningWarning[],
): readonly ExecutionDependency[] {
  return dependencies.filter((dependency) => {
    if (stepIds.has(dependency.stepId) && stepIds.has(dependency.dependsOn)) {
      return true;
    }
    optimizations.push({
      code: 'DANGLING_DEPENDENCY_REMOVED',
      message: `Removed dependency on missing step ${dependency.dependsOn}`,
      stepId: dependency.stepId,
    });
    return false;
  });
}

/** Removes steps that cannot be reached from the plan roots (prompt §17). */
function pruneUnreachableSteps(
  steps: readonly ExecutionStep[],
  dependencies: readonly ExecutionDependency[],
  optimizations: PlanningWarning[],
): {
  readonly steps: readonly ExecutionStep[];
  readonly dependencies: readonly ExecutionDependency[];
} {
  const stepIds = new Set(steps.map((step) => step.stepId));
  const rootIds = new Set(stepIds);

  for (const dependency of dependencies) {
    rootIds.delete(dependency.stepId);
  }

  const reachable = new Set<string>();
  const queue = [...rootIds];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);

    for (const dependency of dependencies) {
      if (dependency.dependsOn === current && !reachable.has(dependency.stepId)) {
        queue.push(dependency.stepId);
      }
    }
  }

  const keptSteps = steps.filter((step) => {
    if (reachable.has(step.stepId)) {
      return true;
    }
    optimizations.push({
      code: 'UNREACHABLE_STEP_REMOVED',
      message: `Removed unreachable step ${step.stepId} for agent ${step.agentId}`,
      stepId: step.stepId,
    });
    return false;
  });

  return {
    steps: keptSteps,
    dependencies,
  };
}

/** Merges identical condition metadata into a single canonical entry. */
function deduplicateConditions(
  conditions: readonly ExecutionCondition[],
  optimizations: PlanningWarning[],
): readonly ExecutionCondition[] {
  const seen = new Map<string, string>();
  const result: ExecutionCondition[] = [];

  for (const condition of conditions) {
    const signature = conditionSignature(condition);
    const existing = seen.get(signature);
    if (existing !== undefined) {
      optimizations.push({
        code: 'CONDITION_MERGED',
        message: `Merged identical condition ${condition.id} into ${existing}`,
        details: { merged: condition.id, kept: existing },
      });
      continue;
    }
    seen.set(signature, condition.id);
    result.push(condition);
  }

  return result;
}

function removeDanglingBranches(
  branches: readonly ExecutionBranch[],
  stepIds: ReadonlySet<string>,
  optimizations: PlanningWarning[],
): readonly ExecutionBranch[] {
  return branches
    .map((branch) => ({
      ...branch,
      stepIds: branch.stepIds.filter((stepId) => stepIds.has(stepId)),
    }))
    .filter((branch) => {
      if (branch.stepIds.length > 0) {
        return true;
      }
      optimizations.push({
        code: 'EMPTY_BRANCH_REMOVED',
        message: `Removed branch ${branch.branchId} with no reachable steps`,
      });
      return false;
    });
}

export const safePlanOptimizer = new SafePlanOptimizer();
