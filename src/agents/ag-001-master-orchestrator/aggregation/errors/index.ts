import { OrchestratorError, type OrchestratorErrorOptions } from '../../errors/index.js';

/** Base error for the response aggregation layer (Sprint 7, prompt §22/§41). */
export class AggregationError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGGREGATION_ERROR' });
  }
}

/** Raised when aggregation input fails validation. */
export class AggregationValidationError extends AggregationError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGGREGATION_VALIDATION_ERROR' });
  }
}

/** Raised when a result cannot be normalized into the internal representation. */
export class ResultNormalizationError extends AggregationError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'RESULT_NORMALIZATION_ERROR' });
  }
}

/** Raised when duplicate results are detected while deduplication is enabled. */
export class DuplicateResultError extends AggregationError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'DUPLICATE_RESULT_ERROR' });
  }
}

/** Raised when the number of results exceeds the configured limit. */
export class ResultLimitError extends AggregationError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'RESULT_LIMIT_ERROR' });
  }
}

/** Raised when a result references an unknown step, agent or plan. */
export class InvalidResultReferenceError extends AggregationError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'INVALID_RESULT_REFERENCE_ERROR' });
  }
}

/** Raised when aggregation state conflicts (e.g. incompatible plans). */
export class AggregationConflictError extends AggregationError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGGREGATION_CONFLICT_ERROR' });
  }
}

/** Raised when the aggregation configuration is invalid. */
export class AggregationConfigError extends AggregationError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGGREGATION_CONFIG_ERROR' });
  }
}
