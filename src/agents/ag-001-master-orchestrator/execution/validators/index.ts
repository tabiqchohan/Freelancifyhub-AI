import { ExecutionMode } from '../../routing/types/index.js';
import { ExecutionValidationError } from '../errors/index.js';
import { buildDependencyGraph } from '../../planning/dependencies/index.js';
import type { ExecutionPlan } from '../../planning/types/index.js';
import type { ExecutionRequest } from '../types/index.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates an execution request before running (prompt §4/§21). */
export function validateExecutionRequest(raw: unknown): asserts raw is ExecutionRequest {
  if (!isRecord(raw)) {
    throw new ExecutionValidationError('Execution request must be an object');
  }

  if (typeof raw.executionId !== 'string' || raw.executionId.trim().length === 0) {
    throw new ExecutionValidationError(
      'Execution request requires a non-empty executionId (idempotency key)',
    );
  }

  if (!isRecord(raw.plan)) {
    throw new ExecutionValidationError('Execution request is missing the execution plan');
  }
}

/** Validates an execution plan before running (prompt §4). */
export function validateExecutionPlan(
  plan: Readonly<Pick<ExecutionPlan, 'planId' | 'mode' | 'steps' | 'dependencies'>>,
): void {
  if (plan.planId.trim().length === 0) {
    throw new ExecutionValidationError('Execution plan requires a non-empty planId');
  }

  const mode = plan.mode as ExecutionMode;
  if (!Object.values(ExecutionMode).includes(mode)) {
    throw new ExecutionValidationError(
      `Execution plan has an invalid execution mode: ${String(plan.mode)}`,
    );
  }

  if (plan.steps.length === 0) {
    throw new ExecutionValidationError('Execution plan has no steps to execute');
  }

  buildDependencyGraph(plan.steps, plan.dependencies);
}
