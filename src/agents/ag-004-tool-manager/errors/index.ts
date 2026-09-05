/** Typed error hierarchy for the AG-004 Tool Manager (Sprint 16). */

export type ToolErrorOptions = {
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
  readonly cause?: unknown;
};

/**
 * Base class for every tool error. Forms a controlled contract so callers can
 * branch on `code` without relying on message text. Never carries secrets or
 * internal stack traces.
 */
export abstract class ToolError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'TOOL_ERROR';
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

/** Raised when a tool input or configuration fails validation. */
export class ToolValidationError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_VALIDATION_ERROR' });
  }
}

/** Raised when the tool configuration is invalid or missing. */
export class ToolConfigurationError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_CONFIGURATION_ERROR' });
  }
}

/** Raised when a requested tool does not exist. */
export class ToolNotFoundError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_NOT_FOUND_ERROR' });
  }
}

/** Raised when a tool is disabled (fail-closed). */
export class ToolDisabledError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_DISABLED_ERROR' });
  }
}

/** Raised when the actor is not permitted to perform the operation. */
export class ToolAccessDeniedError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_ACCESS_DENIED_ERROR' });
  }
}

/** Raised on uniqueness conflicts (duplicate tool/version). */
export class ToolConflictError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_CONFLICT_ERROR' });
  }
}

/** Raised when execution times out. Deterministic, never false success. */
export class ToolTimeoutError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_TIMEOUT_ERROR' });
  }
}

/** Raised when execution is cancelled. */
export class ToolCancellationError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_CANCELLATION_ERROR' });
  }
}

/** Raised when a tool handler fails during execution. */
export class ToolExecutionError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_EXECUTION_ERROR' });
  }
}

/** Raised when the underlying storage layer fails. Retryable. */
export class ToolStorageError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'TOOL_STORAGE_ERROR',
      retryable: true,
    });
  }
}

/** Raised when an event fails validation or persistence. */
export class ToolEventError extends ToolError {
  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_EVENT_ERROR' });
  }
}
