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

/** Raised when the actor lacks the specific permission required. */
export class InsufficientPermissionError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'INSUFFICIENT_PERMISSION_ERROR' });
  }
}

/** Raised when an actor attempts to access memory they do not own. */
export class OwnershipViolationError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'OWNERSHIP_VIOLATION_ERROR' });
  }
}

/** Raised when an actor attempts to access memory outside their scope. */
export class ScopeViolationError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'SCOPE_VIOLATION_ERROR' });
  }
}

/** Raised when an actor's security clearance is insufficient. */
export class SecurityLevelViolationError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'SECURITY_LEVEL_VIOLATION_ERROR' });
  }
}

/** Raised when the actor context is missing or malformed. */
export class InvalidActorContextError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'INVALID_ACTOR_CONTEXT_ERROR' });
  }
}

/** Raised when a lifecycle transition is not allowed (prompt §5). */

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

/**
 * Sprint 7 — Raised when an audit event fails validation (malformed event).
 * Non-retryable: a malformed event will not become valid on retry.
 */
export class MemoryEventValidationError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_EVENT_VALIDATION_ERROR' });
  }
}

/**
 * Sprint 7 — Raised when an event with an already-present id is appended to the
 * append-only EventLog. Non-retryable (409 semantics for the audit trail).
 */
export class MemoryDuplicateEventError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_DUPLICATE_EVENT_ERROR' });
  }
}

/** Sprint 7 — Raised when a requested audit event does not exist. */
export class MemoryEventNotFoundError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_EVENT_NOT_FOUND_ERROR' });
  }
}

/**
 * Sprint 7 — Raised when an operation is not supported by the EventLog (e.g.
 * mutate/delete historical events). The audit trail is append-only by design.
 */
export class MemoryUnsupportedOperationError extends MemoryError {
  constructor(message: string, options: MemoryErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'MEMORY_UNSUPPORTED_OPERATION_ERROR' });
  }
}
