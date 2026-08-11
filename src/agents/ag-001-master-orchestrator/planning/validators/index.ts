import { ExecutionPlanValidationError } from '../errors/index.js';
import { ExecutionMode } from '../../routing/types/index.js';
import { IntentId, UserRole, validateIntentResult } from '../../intent/index.js';
import type { ExecutionConstraints, ExecutionPlan, PlanningRequest } from '../types/index.js';
import { buildDependencyGraph } from '../dependencies/index.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the raw planning request structure (prompt §9/§14). */
export function validatePlanningRequest(raw: unknown): asserts raw is PlanningRequest {
  if (!isRecord(raw)) {
    throw new ExecutionPlanValidationError('Planning request must be an object');
  }

  if (!isRecord(raw.request)) {
    throw new ExecutionPlanValidationError('Planning request is missing the agent request');
  }

  if (raw.request.agentId === undefined || typeof raw.request.agentId !== 'string') {
    throw new ExecutionPlanValidationError('Planning request agentId must be a non-empty string');
  }

  if (raw.intent === undefined) {
    throw new ExecutionPlanValidationError('Planning request is missing the intent result');
  }

  validateIntentResult(raw.intent as never);

  if (!isRecord(raw.context)) {
    throw new ExecutionPlanValidationError('Planning request is missing the context snapshot');
  }

  if (!isRecord(raw.route)) {
    throw new ExecutionPlanValidationError('Planning request is missing the route decision');
  }

  if (raw.role === undefined || !Object.values(UserRole).includes(raw.role as UserRole)) {
    throw new ExecutionPlanValidationError('Planning request has an invalid user role');
  }

  validateRouteDecision(raw.route as never);
  validateConstraints(raw.constraints as ExecutionConstraints | undefined);
}

/** Validates a route decision before planning (prompt §9/§10). */
export function validateRouteDecision(route: unknown): void {
  if (!isRecord(route)) {
    throw new ExecutionPlanValidationError('Route decision must be an object');
  }

  const mode = route.executionMode as ExecutionMode;
  if (!Object.values(ExecutionMode).includes(mode)) {
    throw new ExecutionPlanValidationError(
      `Route decision has an invalid execution mode: ${String(route.executionMode)}`,
    );
  }

  if (
    route.intentId === undefined ||
    !Object.values(IntentId).includes(route.intentId as IntentId)
  ) {
    throw new ExecutionPlanValidationError('Route decision has an invalid intent id');
  }

  const candidates = Array.isArray(route.candidates) ? route.candidates : [];
  for (const candidate of candidates) {
    if (
      !isRecord(candidate) ||
      !isRecord(candidate.agent) ||
      typeof candidate.agent.agentId !== 'string'
    ) {
      throw new ExecutionPlanValidationError('Route decision contains an invalid candidate agent');
    }
  }

  if (mode !== ExecutionMode.Single && candidates.length === 0) {
    throw new ExecutionPlanValidationError(
      `Route decision requires at least one candidate for mode ${mode}`,
    );
  }
}

/** Validates planning constraints (prompt §9). */
export function validateConstraints(constraints: ExecutionConstraints | undefined): void {
  if (constraints === undefined) {
    return;
  }

  const positiveInteger = (value: number | undefined, name: string): void => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new ExecutionPlanValidationError(
        `Planning constraints ${name} must be a positive integer`,
      );
    }
  };

  positiveInteger(constraints.maxSteps, 'maxSteps');
  positiveInteger(constraints.maxDepth, 'maxDepth');
  positiveInteger(constraints.maxParallelBranches, 'maxParallelBranches');
  positiveInteger(constraints.maxTotalExecutionTimeMs, 'maxTotalExecutionTimeMs');
}

/** Validates a completed plan (prompt §9). */
export function validatePlan(
  plan: Readonly<Pick<ExecutionPlan, 'steps' | 'dependencies' | 'constraints' | 'mode'>>,
): void {
  const effectiveMaxSteps = plan.constraints.maxSteps;
  if (effectiveMaxSteps !== undefined && plan.steps.length > effectiveMaxSteps) {
    throw new ExecutionPlanValidationError(
      `Execution plan exceeds maximum steps: ${plan.steps.length} > ${effectiveMaxSteps}`,
    );
  }

  buildDependencyGraph(plan.steps, plan.dependencies);
}
