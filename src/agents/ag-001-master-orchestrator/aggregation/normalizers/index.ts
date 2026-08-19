import { ExecutionStatus } from '../../types/index.js';
import { ExecutionEventType } from '../../execution/types/index.js';
import type { ExecutionResult, ExecutionStepResult } from '../../execution/types/index.js';
import type { ExecutionPlan, ExecutionStep } from '../../planning/types/index.js';
import { FailurePolicy } from '../../planning/types/index.js';
import type { ResultNormalizer } from '../interfaces/index.js';
import type {
  AggregationInput,
  NormalizedResult,
  ResultError,
  ResultGroup,
  ResultWarning,
  RetrySummary,
} from '../types/index.js';
import { ResultGroup as ResultGroupValue } from '../types/index.js';
import { ResultNormalizationError } from '../errors/index.js';
import { sanitizeRecord } from '../utils/index.js';
import type { AggregationConfig } from '../config/index.js';

/** Groups a normalized step result into the coarse bucket (prompt §4/§32). */
export function groupForStatus(status: ExecutionStatus, skipped?: boolean): ResultGroup {
  if (skipped === true) {
    return ResultGroupValue.Skipped;
  }
  switch (status) {
    case ExecutionStatus.Succeeded:
      return ResultGroupValue.Successful;
    case ExecutionStatus.Failed:
      return ResultGroupValue.Failed;
    case ExecutionStatus.TimedOut:
      return ResultGroupValue.TimedOut;
    case ExecutionStatus.Cancelled:
      return ResultGroupValue.Cancelled;
    case ExecutionStatus.Running:
    case ExecutionStatus.Pending:
      return ResultGroupValue.Pending;
    default:
      return ResultGroupValue.Pending;
  }
}

/** Converts an execution error into a safe, structured result error (prompt §11). */
export function toResultError(
  error: { readonly code: string; readonly message: string; readonly retryable: boolean },
  executionId: string,
  step?: ExecutionStepResult,
): ResultError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    stepId: step?.stepId,
    agentId: step?.agentId,
    executionId,
    attempt: step?.attemptCount,
    metadata: { retryable: error.retryable },
  };
}

/**
 * Deterministic normalizer (prompt §2/§30). Transforms execution results into
 * a common internal representation without mutating the original result.
 */
export class ExecutionResultNormalizer implements ResultNormalizer {
  readonly name = 'execution-result-normalizer';
  private readonly config: AggregationConfig;

  constructor(config: AggregationConfig) {
    this.config = config;
  }

  normalize(input: AggregationInput): readonly NormalizedResult[] {
    const stepPolicy = this.stepPolicyIndex(input.plan);
    const normalized: NormalizedResult[] = [];

    for (const execution of input.results) {
      for (const step of execution.stepResults) {
        normalized.push(this.normalizeStep(execution, step, stepPolicy));
      }
    }

    return normalized;
  }

  /** Derives retry history from step attempts and retry events (prompt §7/§33). */
  retries(execution: ExecutionResult): readonly RetrySummary[] {
    const summaries: RetrySummary[] = [];

    for (const step of execution.stepResults) {
      if (step.attemptCount <= 1) {
        continue;
      }

      const retryingAttempts = execution.events
        .filter(
          (event) => event.type === ExecutionEventType.StepRetrying && event.stepId === step.stepId,
        )
        .map((event) => event.attempt ?? 0)
        .sort((a, b) => a - b);

      const failedAttempts = retryingAttempts
        .map((attempt) => Math.max(attempt - 1, 0))
        .filter((attempt) => attempt > 0);

      summaries.push({
        stepId: step.stepId,
        successfulAttempt:
          step.status === ExecutionStatus.Succeeded ? step.attemptCount : undefined,
        failedAttempts,
        finalAttempt: step.attemptCount,
        retryCount: Math.max(step.attemptCount - 1, 0),
      });
    }

    return summaries;
  }

  private normalizeStep(
    execution: ExecutionResult,
    step: ExecutionStepResult,
    stepPolicy: ReadonlyMap<string, ExecutionStep>,
  ): NormalizedResult {
    const policy = stepPolicy.get(step.stepId);
    const group = groupForStatus(step.status, step.skipped);
    const warnings = this.buildWarnings(step, policy, group);
    const error =
      step.error === undefined ? undefined : toResultError(step.error, execution.executionId, step);

    return {
      executionId: execution.executionId,
      planId: execution.planId,
      stepId: step.stepId,
      agentId: step.agentId,
      order: step.order,
      status: step.status,
      group,
      output: sanitizeRecord(step.output),
      error,
      warnings,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      durationMs: step.durationMs,
      attemptCount: step.attemptCount,
      metadata: sanitizeRecord(step.metadata ?? {}) as Readonly<Record<string, unknown>>,
      skipped: step.skipped,
      key: `${execution.executionId}:${step.stepId}`,
    };
  }

  private buildWarnings(
    step: ExecutionStepResult,
    policy: ExecutionStep | undefined,
    group: ResultGroup,
  ): readonly ResultWarning[] {
    const warnings: ResultWarning[] = [];

    if (this.config.AGGREGATION_INCLUDE_WARNINGS === false) {
      return warnings;
    }

    if (step.skipped === true) {
      warnings.push({
        code: 'STEP_SKIPPED',
        message: `Step ${step.stepId} was skipped`,
        stepId: step.stepId,
        agentId: step.agentId,
      });
    }

    if (step.attemptCount > 1) {
      warnings.push({
        code: 'RETRY_OCCURRED',
        message: `Step ${step.stepId} retried ${step.attemptCount - 1} time(s)`,
        stepId: step.stepId,
        agentId: step.agentId,
        details: { retryCount: step.attemptCount - 1 },
      });
    }

    if (policy?.policy.failureBehavior === FailurePolicy.Fallback) {
      warnings.push({
        code: 'FALLBACK_USED',
        message: `Step ${step.stepId} is governed by a fallback policy`,
        stepId: step.stepId,
        agentId: step.agentId,
      });
    }

    if (group === ResultGroupValue.TimedOut || step.status === ExecutionStatus.TimedOut) {
      warnings.push({
        code: 'STEP_TIMED_OUT',
        message: `Step ${step.stepId} exceeded its timeout`,
        stepId: step.stepId,
        agentId: step.agentId,
      });
    }

    if (
      step.status === ExecutionStatus.Failed &&
      policy?.policy.failureBehavior === FailurePolicy.Continue
    ) {
      warnings.push({
        code: 'NON_CRITICAL_FAILURE',
        message: `Step ${step.stepId} failed under a continue policy`,
        stepId: step.stepId,
        agentId: step.agentId,
      });
    }

    return warnings;
  }

  /** Validates the step structure before normalization (prompt §21/§41). */
  private stepPolicyIndex(plan: ExecutionPlan): ReadonlyMap<string, ExecutionStep> {
    const index = new Map<string, ExecutionStep>();

    for (const step of plan.steps) {
      if (step.stepId.trim().length === 0) {
        throw new ResultNormalizationError('Execution plan contains a step with an empty stepId');
      }
      if (index.has(step.stepId)) {
        throw new ResultNormalizationError(
          `Execution plan contains duplicate step id: ${step.stepId}`,
          { details: { stepId: step.stepId } },
        );
      }
      index.set(step.stepId, step);
    }

    return index;
  }
}
