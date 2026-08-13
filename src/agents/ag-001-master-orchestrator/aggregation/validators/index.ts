import { ExecutionStatus } from '../../types/index.js';
import { ExecutionState } from '../../execution/types/index.js';
import type { ExecutionResult } from '../../execution/types/index.js';
import type { AggregationInput } from '../types/index.js';
import type { AggregationConfig } from '../config/index.js';
import {
  AggregationValidationError,
  DuplicateResultError,
  InvalidResultReferenceError,
  ResultLimitError,
} from '../errors/index.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExecutionState(value: unknown): value is ExecutionState {
  return (
    typeof value === 'string' && Object.values(ExecutionState).includes(value as ExecutionState)
  );
}

function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return (
    typeof value === 'string' && Object.values(ExecutionStatus).includes(value as ExecutionStatus)
  );
}

/** Validates the full aggregation input before processing (prompt §21/§41). */
export function validateAggregationInput(input: AggregationInput, config: AggregationConfig): void {
  if (!isRecord(input)) {
    throw new AggregationValidationError('Aggregation input must be an object');
  }

  if (typeof input.executionId !== 'string' || input.executionId.trim().length === 0) {
    throw new AggregationValidationError('Aggregation input requires a non-empty executionId');
  }

  if (!isRecord(input.plan)) {
    throw new InvalidResultReferenceError(
      'Aggregation input is missing its execution plan reference',
    );
  }

  if (!Array.isArray(input.results)) {
    throw new AggregationValidationError('Aggregation input requires a results array');
  }

  if (input.results.length === 0 && config.AGGREGATION_STRICT_VALIDATION) {
    throw new AggregationValidationError('Aggregation input has no results to aggregate');
  }

  if (input.results.length > config.AGGREGATION_MAX_RESULT_COUNT) {
    throw new ResultLimitError(
      `Aggregation result count exceeds the configured limit of ` +
        `${config.AGGREGATION_MAX_RESULT_COUNT}`,
      { details: { count: input.results.length, limit: config.AGGREGATION_MAX_RESULT_COUNT } },
    );
  }

  const seen = new Set<string>();

  for (const result of input.results) {
    validateExecutionResult(result);
    const key = `${result.executionId}:${result.planId}`;
    if (seen.has(key) && config.AGGREGATION_STRICT_VALIDATION) {
      throw new DuplicateResultError(
        `Duplicate execution result for ${result.executionId} / ${result.planId}`,
        { details: { executionId: result.executionId, planId: result.planId } },
      );
    }
    seen.add(key);
  }

  if (input.plan.planId.trim().length === 0) {
    throw new InvalidResultReferenceError('Execution plan requires a non-empty planId');
  }

  for (const result of input.results) {
    if (result.planId !== input.plan.planId) {
      throw new InvalidResultReferenceError(
        `Execution result ${result.executionId} references plan ${result.planId} ` +
          `but aggregation was given plan ${input.plan.planId}`,
      );
    }
  }
}

/** Validates a single execution result structure (prompt §21/§41). */
export function validateExecutionResult(result: unknown): asserts result is ExecutionResult {
  if (!isRecord(result)) {
    throw new AggregationValidationError('Execution result must be an object');
  }

  if (typeof result.executionId !== 'string' || result.executionId.trim().length === 0) {
    throw new AggregationValidationError('Execution result requires a non-empty executionId');
  }

  if (typeof result.planId !== 'string' || result.planId.trim().length === 0) {
    throw new AggregationValidationError('Execution result requires a non-empty planId');
  }

  if (!isExecutionState(result.state)) {
    throw new AggregationValidationError(
      `Execution result has an invalid execution state: ${String(result.state)}`,
    );
  }

  if (!Array.isArray(result.stepResults)) {
    throw new AggregationValidationError('Execution result requires a stepResults array');
  }

  const stepIds = new Set<string>();

  for (const step of result.stepResults) {
    if (!isRecord(step)) {
      throw new AggregationValidationError('Step result must be an object');
    }

    if (typeof step.stepId !== 'string' || step.stepId.trim().length === 0) {
      throw new AggregationValidationError('Step result requires a non-empty stepId');
    }

    if (typeof step.agentId !== 'string' || step.agentId.trim().length === 0) {
      throw new AggregationValidationError(
        `Step result ${step.stepId} requires a non-empty agentId`,
      );
    }

    if (!isExecutionStatus(step.status)) {
      throw new AggregationValidationError(
        `Step result ${step.stepId} has an invalid status: ${String(step.status)}`,
      );
    }

    if (stepIds.has(step.stepId)) {
      throw new DuplicateResultError(
        `Execution result contains duplicate step id: ${step.stepId}`,
        { details: { stepId: step.stepId } },
      );
    }
    stepIds.add(step.stepId);
  }
}
