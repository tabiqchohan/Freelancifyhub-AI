import { OrchestratorError, type OrchestratorErrorOptions } from '../../errors/index.js';

/**
 * Base error for the execution planner (Sprint 5, prompt §19). Also the
 * structured error type carried on planning results.
 */
export class ExecutionPlanningError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_PLANNING_ERROR' });
  }
}

/** Raised when planning input fails validation. */
export class ExecutionPlanValidationError extends ExecutionPlanningError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_PLAN_VALIDATION_ERROR' });
  }
}

/** Raised when the step dependency graph is invalid. */
export class ExecutionDependencyError extends ExecutionPlanningError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_DEPENDENCY_ERROR' });
  }
}

/** Raised when the dependency graph contains a cycle. */
export class ExecutionCycleError extends ExecutionDependencyError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_CYCLE_ERROR' });
  }
}

/** Raised when planning constraints cannot be satisfied. */
export class ExecutionConstraintError extends ExecutionPlanningError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_CONSTRAINT_ERROR' });
  }
}

/** Raised when a plan exceeds a configured limit (steps, depth, branches). */
export class ExecutionPlanLimitError extends ExecutionConstraintError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_PLAN_LIMIT_ERROR' });
  }
}

/** Raised when the requested execution mode is unsupported or disabled. */
export class UnsupportedExecutionModeError extends ExecutionPlanningError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'UNSUPPORTED_EXECUTION_MODE_ERROR' });
  }
}

/** Raised when the planning configuration is invalid. */
export class PlanningConfigError extends ExecutionPlanningError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'PLANNING_CONFIG_ERROR' });
  }
}
