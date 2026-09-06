/**
 * Sprint 18 — Agentic Tool-Calling. Normalized error model.
 *
 * Follows the project error conventions (LLMError, ToolError): stable `code`,
 * optional safe `details`, unguarded internal `cause`, and a `retryable` flag.
 * Error messages never contain secrets, raw prompts, or stack traces.
 */

/** Options for constructing an agentic error. */
export interface AgenticLoopErrorOptions {
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/** Base error for the agentic reasoning/tool loop. */
export abstract class AgenticLoopError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'AGENTIC_ERROR';
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

/** Raised when the loop exceeds a configured bound. Never retried. */
export class AgenticLoopLimitReachedError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGENTIC_LOOP_LIMIT_REACHED' });
  }
}

/** Raised when the whole agentic operation exceeds its deadline. */
export class AgenticLoopTimeoutError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGENTIC_LOOP_TIMEOUT' });
  }
}

/** Raised when the operation is cancelled via AbortSignal. */
export class AgenticLoopCancelledError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGENTIC_LOOP_CANCELLED' });
  }
}

/** Raised when an illegal state transition is attempted. */
export class AgenticStateTransitionError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGENTIC_STATE_TRANSITION_INVALID' });
  }
}

/** Raised when model output is not a valid structured decision. */
export class ToolDecisionInvalidError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_DECISION_INVALID' });
  }
}

/** Raised when a proposed tool does not exist in the registry. */
export class AgenticToolNotFoundError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_NOT_FOUND' });
  }
}

/** Raised when a proposed tool is not authorized for the current actor. */
export class AgenticToolNotAuthorizedError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_NOT_AUTHORIZED' });
  }
}

/** Raised when a proposed tool call fails argument validation. */
export class AgenticToolArgumentsInvalidError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_ARGUMENTS_INVALID' });
  }
}

/** Raised when an authorized tool execution fails through AG-004. */
export class AgenticToolExecutionFailedError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_EXECUTION_FAILED' });
  }
}

/** Raised when a raw tool result cannot be safely included in context. */
export class AgenticToolResultInvalidError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'TOOL_RESULT_INVALID' });
  }
}

/** Raised when the underlying reasoning call fails. */
export class AgenticReasoningFailedError extends AgenticLoopError {
  constructor(message: string, options: AgenticLoopErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGENTIC_REASONING_FAILED' });
  }
}

/** Stable classes used for metrics/events classification. */
export type AgenticErrorClass =
  'limit' | 'timeout' | 'cancelled' | 'decision' | 'tool' | 'reasoning' | 'state' | 'internal';

/** Classifies an agentic error (or any thrown value). */
export function classifyAgenticError(error: unknown): {
  readonly errorClass: AgenticErrorClass;
  readonly retryable: boolean;
  readonly code: string;
} {
  if (error instanceof AgenticLoopLimitReachedError) {
    return { errorClass: 'limit', retryable: false, code: error.code };
  }
  if (error instanceof AgenticLoopTimeoutError) {
    return { errorClass: 'timeout', retryable: false, code: error.code };
  }
  if (error instanceof AgenticLoopCancelledError) {
    return { errorClass: 'cancelled', retryable: false, code: error.code };
  }
  if (error instanceof AgenticStateTransitionError) {
    return { errorClass: 'state', retryable: false, code: error.code };
  }
  if (error instanceof ToolDecisionInvalidError) {
    return { errorClass: 'decision', retryable: false, code: error.code };
  }
  if (
    error instanceof AgenticToolNotFoundError ||
    error instanceof AgenticToolNotAuthorizedError ||
    error instanceof AgenticToolArgumentsInvalidError ||
    error instanceof AgenticToolExecutionFailedError ||
    error instanceof AgenticToolResultInvalidError
  ) {
    return { errorClass: 'tool', retryable: false, code: error.code };
  }
  if (error instanceof AgenticReasoningFailedError) {
    return { errorClass: 'reasoning', retryable: error.retryable, code: error.code };
  }
  if (error instanceof AgenticLoopError) {
    return { errorClass: 'internal', retryable: error.retryable, code: error.code };
  }
  return { errorClass: 'internal', retryable: false, code: 'AGENTIC_ERROR' };
}
