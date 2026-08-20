/** Typed error hierarchy for the AG-002 Shared Memory Manager (prompt §16). */

export type MemoryErrorOptions = {
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
  readonly cause?: unknown;
};

/**
 * Base class for every memory error. Forms a controlled contract so callers
 * can branch on `code` without relying on message text (blueprint §21.2
 * problem-details style, AG-001 convention).
 */
export abstract class MemoryError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'MEMORY_ERROR';
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

/** Raised when an input or configuration value fails validation. */
export class MemoryValidationError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_VALIDATION_ERROR' });
  }
}

/** Raised when the memory configuration is invalid or missing. */
export class MemoryConfigurationError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_CONFIGURATION_ERROR' });
  }
}

/** Raised when a requested memory record does not exist (or is expired). */
export class MemoryNotFoundError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_NOT_FOUND_ERROR' });
  }
}

/** Raised when the actor is not permitted to perform the operation. */
export class MemoryAccessDeniedError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_ACCESS_DENIED_ERROR' });
  }
}

/** Raised when a lifecycle transition is not allowed (prompt §5). */
export class MemoryLifecycleTransitionError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_LIFECYCLE_TRANSITION_ERROR' });
  }
}

/** Raised when a retention/TTL policy is violated or inconsistent. */
export class MemoryRetentionError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_RETENTION_ERROR' });
  }
}

/** Raised when the underlying storage layer fails. */
export class MemoryStorageError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_STORAGE_ERROR', retryable: true });
  }
}

/** Raised when retrieval cannot be performed. */
export class MemoryRetrievalError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_RETRIEVAL_ERROR' });
  }
}

/** Raised on optimistic-concurrency or uniqueness conflicts (409 semantics). */
export class MemoryConflictError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_CONFLICT_ERROR' });
  }
}
