import { OrchestratorError, type OrchestratorErrorOptions } from '../../errors/index.js';
import type { OrchestratorStage } from '../types/index.js';

/** Correlation carried by every orchestration error. */
export interface OrchestrationCorrelation {
  readonly requestId?: string;
  readonly traceId?: string;
}

/**
 * Orchestration-level error raised when a lifecycle stage fails. It wraps the
 * underlying engine error, preserving its `code` and `retryable` state and
 * attaching the failing stage plus correlation ids (prompt §12).
 */
export class OrchestrationError extends OrchestratorError {
  readonly stage?: OrchestratorStage;
  readonly requestId?: string;
  readonly traceId?: string;

  constructor(
    message: string,
    options: OrchestratorErrorOptions & {
      readonly stage?: OrchestratorStage;
      readonly correlation?: OrchestrationCorrelation;
    } = {},
  ) {
    super(message, {
      ...options,
      code: options.code ?? 'ORCHESTRATION_ERROR',
      retryable: options.retryable ?? true,
      details: {
        ...(options.stage === undefined ? {} : { stage: options.stage }),
        ...options.correlation,
        ...options.details,
      },
    });
    this.stage = options.stage;
    this.requestId = options.correlation?.requestId;
    this.traceId = options.correlation?.traceId;
  }
}

/**
 * Converts an arbitrary thrown value into a typed {@link OrchestrationError}.
 * Errors already in the orchestrator hierarchy keep their `code` and
 * `retryable` flags; unknown errors collapse to a safe generic code. No
 * internal details are leaked beyond what the original error already carried.
 */
export function toOrchestrationError(
  stage: OrchestratorStage,
  error: unknown,
  correlation: OrchestrationCorrelation = {},
): OrchestrationError {
  const details = error instanceof OrchestratorError ? error.details : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof OrchestratorError) {
    return new OrchestrationError(`[${stage}] ${error.message}`, {
      code: error.code,
      retryable: error.retryable,
      cause: error,
      details,
      stage,
      correlation,
    });
  }

  return new OrchestrationError(`[${stage}] ${message}`, {
    code: 'STAGE_ERROR',
    retryable: false,
    cause: error,
    stage,
    correlation,
  });
}
