/** Typed error hierarchy for the AG-003 Knowledge Manager (Sprint 15). */

export type KnowledgeErrorOptions = {
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
  readonly cause?: unknown;
};

/**
 * Base class for every knowledge error. Forms a controlled contract so callers
 * can branch on `code` without relying on message text.
 */
export abstract class KnowledgeError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'KNOWLEDGE_ERROR';
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

/** Raised when input or configuration fails validation. */
export class KnowledgeValidationError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'KNOWLEDGE_VALIDATION_ERROR' });
  }
}

/** Raised when configuration is invalid or missing. */
export class KnowledgeConfigurationError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'KNOWLEDGE_CONFIGURATION_ERROR' });
  }
}

/** Raised when a knowledge document does not exist. */
export class KnowledgeNotFoundError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'KNOWLEDGE_NOT_FOUND_ERROR' });
  }
}

/** Raised when the actor is not permitted to perform the operation. */
export class KnowledgeAccessDeniedError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'KNOWLEDGE_ACCESS_DENIED_ERROR' });
  }
}

/** Raised when a lifecycle transition is not allowed. */
export class KnowledgeLifecycleTransitionError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'KNOWLEDGE_LIFECYCLE_TRANSITION_ERROR' });
  }
}

/** Raised when the underlying storage layer fails. */
export class KnowledgeStorageError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'KNOWLEDGE_STORAGE_ERROR',
      retryable: true,
    });
  }
}

/** Raised when retrieval cannot be performed. */
export class KnowledgeRetrievalError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'KNOWLEDGE_RETRIEVAL_ERROR' });
  }
}

/** Raised on uniqueness conflicts (409 semantics). */
export class KnowledgeConflictError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'KNOWLEDGE_CONFLICT_ERROR' });
  }
}

/** Raised when version operations fail. */
export class KnowledgeVersionError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'KNOWLEDGE_VERSION_ERROR' });
  }
}

/** Raised when an event fails validation. */
export class KnowledgeEventValidationError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'KNOWLEDGE_EVENT_VALIDATION_ERROR' });
  }
}

/** Raised when a chunking operation fails. */
export class KnowledgeChunkingError extends KnowledgeError {
  constructor(message: string, options: KnowledgeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'KNOWLEDGE_CHUNKING_ERROR' });
  }
}
