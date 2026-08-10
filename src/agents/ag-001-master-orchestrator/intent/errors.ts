import { OrchestratorError, type OrchestratorErrorOptions } from '../errors/index.js';

/** Raised when classification fails while processing a request. */
export class IntentClassificationError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'INTENT_CLASSIFICATION_ERROR' });
  }
}

/** Raised when the intent registry is inconsistent or invalid. */
export class IntentRegistryError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'INTENT_REGISTRY_ERROR' });
  }
}

/** Raised when an intent definition or classification input fails validation. */
export class IntentValidationError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'INTENT_VALIDATION_ERROR' });
  }
}
