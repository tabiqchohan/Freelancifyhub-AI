import { OrchestratorError, type OrchestratorErrorOptions } from '../../errors/index.js';

/** Base error for the execution engine (Sprint 6, prompt §23). */
export class ExecutionEngineError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_ENGINE_ERROR' });
  }
}

/** Raised when an execution request or plan fails validation. */
export class ExecutionValidationError extends ExecutionEngineError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_VALIDATION_ERROR' });
  }
}

/** Raised when an invalid state transition is attempted. */
export class ExecutionStateError extends ExecutionEngineError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_STATE_ERROR' });
  }
}

/** Raised when an agent executor fails or is unavailable. */
export class AgentExecutorError extends ExecutionEngineError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGENT_EXECUTOR_ERROR', retryable: true });
  }
}

/** Raised when a step or the overall execution exceeds its timeout. */
export class ExecutionTimeoutError extends ExecutionEngineError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_TIMEOUT_ERROR' });
  }
}

/** Raised when a running execution is cancelled. */
export class ExecutionCancelledError extends ExecutionEngineError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_CANCELLED_ERROR' });
  }
}

/** Raised when a step exhausts its retry budget. */
export class ExecutionRetryError extends ExecutionEngineError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_RETRY_ERROR' });
  }
}

/** Raised when an input reference cannot be resolved. */
export class ExecutionInputResolutionError extends ExecutionEngineError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_INPUT_RESOLUTION_ERROR' });
  }
}

/** Raised when a concurrency limit is violated. */
export class ExecutionConcurrencyError extends ExecutionEngineError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_CONCURRENCY_ERROR' });
  }
}

/** Raised when an execution/step exceeds a configured limit. */
export class ExecutionLimitError extends ExecutionEngineError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_LIMIT_ERROR' });
  }
}

/** Raised when the execution configuration is invalid. */
export class ExecutionConfigError extends ExecutionEngineError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'EXECUTION_CONFIG_ERROR' });
  }
}
