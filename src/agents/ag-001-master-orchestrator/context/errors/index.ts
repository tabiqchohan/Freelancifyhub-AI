import { OrchestratorError, type OrchestratorErrorOptions } from '../../errors/index.js';

/** Shared options for context errors, including the offending item id. */
export interface ContextBuildErrorOptions extends OrchestratorErrorOptions {
  readonly itemId?: string;
}

/**
 * Base error for the context builder engine. Also serves as the structured
 * error type carried on {@link ContextBuildResult} (prompt §1/§14).
 */
export class ContextBuildError extends OrchestratorError {
  readonly itemId?: string;

  constructor(message: string, options: ContextBuildErrorOptions = {}) {
    super(message, options);
    this.itemId = options.itemId;
  }
}

/** Raised when a context build request fails validation. */
export class ContextValidationError extends ContextBuildError {
  constructor(message: string, options: ContextBuildErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'CONTEXT_VALIDATION_ERROR' });
  }
}

/** Raised when the supplied budget is invalid. */
export class ContextBudgetError extends ContextBuildError {
  constructor(message: string, options: ContextBuildErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'CONTEXT_BUDGET_ERROR' });
  }
}

/** Raised when the context cannot fit the budget (critical overflow / fail). */
export class ContextOverflowError extends ContextBuildError {
  constructor(message: string, options: ContextBuildErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'CONTEXT_OVERFLOW_ERROR', retryable: true });
  }
}

/** Raised when an item cannot be normalized safely. */
export class ContextNormalizationError extends ContextBuildError {
  constructor(message: string, options: ContextBuildErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'CONTEXT_NORMALIZATION_ERROR' });
  }
}
