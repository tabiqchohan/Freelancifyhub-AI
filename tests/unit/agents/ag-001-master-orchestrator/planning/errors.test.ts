import { describe, expect, it } from 'vitest';

import {
  ExecutionPlanningError,
  ExecutionPlanValidationError,
  ExecutionDependencyError,
  ExecutionCycleError,
  ExecutionConstraintError,
  UnsupportedExecutionModeError,
  ExecutionPlanLimitError,
  PlanningConfigError,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/errors/index.js';
import { OrchestratorError } from '../../../../../src/agents/ag-001-master-orchestrator/errors/index.js';

describe('planning error hierarchy', () => {
  it('is a subclass of OrchestratorError', () => {
    expect(new ExecutionPlanningError('boom')).toBeInstanceOf(OrchestratorError);
    expect(new ExecutionPlanningError('boom')).toBeInstanceOf(Error);
  });

  it('assigns a default code to the base error', () => {
    const error = new ExecutionPlanningError('boom');

    expect(error.code).toBe('EXECUTION_PLANNING_ERROR');
    expect(error.retryable).toBe(false);
  });

  it('assigns typed codes to subclasses', () => {
    expect(new ExecutionPlanValidationError('x').code).toBe('EXECUTION_PLAN_VALIDATION_ERROR');
    expect(new ExecutionDependencyError('x').code).toBe('EXECUTION_DEPENDENCY_ERROR');
    expect(new ExecutionCycleError('x').code).toBe('EXECUTION_CYCLE_ERROR');
    expect(new ExecutionConstraintError('x').code).toBe('EXECUTION_CONSTRAINT_ERROR');
    expect(new UnsupportedExecutionModeError('x').code).toBe('UNSUPPORTED_EXECUTION_MODE_ERROR');
    expect(new ExecutionPlanLimitError('x').code).toBe('EXECUTION_PLAN_LIMIT_ERROR');
    expect(new PlanningConfigError('x').code).toBe('PLANNING_CONFIG_ERROR');
  });

  it('preserves the error hierarchy', () => {
    expect(new ExecutionCycleError('x')).toBeInstanceOf(ExecutionDependencyError);
    expect(new ExecutionPlanLimitError('x')).toBeInstanceOf(ExecutionConstraintError);
  });

  it('carries details and custom codes', () => {
    const error = new ExecutionPlanLimitError('limit reached', {
      code: 'CUSTOM',
      details: { maxSteps: 5 },
    });

    expect(error.code).toBe('CUSTOM');
    expect(error.details).toEqual({ maxSteps: 5 });
  });

  it('preserves the subclass name', () => {
    expect(new ExecutionCycleError('x').name).toBe('ExecutionCycleError');
  });
});
