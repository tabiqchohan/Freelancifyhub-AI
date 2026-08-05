/** Typed error hierarchy for the Master Orchestrator foundation. */

export type OrchestratorErrorOptions = {
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
  readonly cause?: unknown;
};

/**
 * Base class for every orchestrator error. Forms a controlled contract so
 * callers can branch on `code` without relying on message text (blueprint
 * §21.2 problem-details style).
 */
export abstract class OrchestratorError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'ORCHESTRATOR_ERROR';
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

/** Raised when an input or configuration value fails validation. */
export class ValidationError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'VALIDATION_ERROR' });
  }
}

/** Raised when the agent/environment configuration is invalid or missing. */
export class ConfigurationError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'CONFIGURATION_ERROR' });
  }
}

/** Raised when a pipeline cannot be built or executed. */
export class PipelineError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'PIPELINE_ERROR', retryable: true });
  }
}

/** Raised when a required dependency is missing or unavailable. */
export class DependencyError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'DEPENDENCY_ERROR', retryable: true });
  }
}

/** Raised when an operation exceeds its deadline. */
export class TimeoutError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TIMEOUT_ERROR', retryable: true });
  }
}
