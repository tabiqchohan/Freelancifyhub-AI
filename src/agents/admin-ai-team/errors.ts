/**
 * Sprint 25 — Admin AI Team v1. Typed, deterministic domain errors.
 *
 * Every error carries a stable machine-readable code and a safe message that
 * never embeds secrets, prompts, platform data or untrusted admin content
 * verbatim. The admin team is the highest-sensitivity AI team: authorization
 * and approval failures are explicit, never collapsed into a generic
 * "something went wrong", and an authorization denial never reveals why a
 * resource is restricted (prompt §6, §24).
 */

import {
  CoordinationAgentRejectedError,
  CoordinationError,
  CoordinationTimeoutError,
} from '../agent-platform/coordination/errors.js';

/** Stable, machine-readable admin-AI error codes. */
export const ADMIN_AI_ERROR_CODES = {
  INVALID_INPUT: 'ADMIN_AI_INVALID_INPUT',
  UNKNOWN_INTENT: 'ADMIN_AI_UNKNOWN_INTENT',
  UNKNOWN_CAPABILITY: 'ADMIN_AI_UNKNOWN_CAPABILITY',
  UNAUTHORIZED: 'ADMIN_AI_UNAUTHORIZED',
  FORBIDDEN: 'ADMIN_AI_FORBIDDEN',
  PROMPT_INJECTION: 'ADMIN_AI_PROMPT_INJECTION',
  AGENT_REJECTED: 'ADMIN_AI_AGENT_REJECTED',
  COORDINATION_FAILED: 'ADMIN_AI_COORDINATION_FAILED',
  COORDINATION_TIMEOUT: 'ADMIN_AI_COORDINATION_TIMEOUT',
  CANCELLED: 'ADMIN_AI_CANCELLED',
  INSUFFICIENT_DATA: 'ADMIN_AI_INSUFFICIENT_DATA',
  REASONING_UNAVAILABLE: 'ADMIN_AI_REASONING_UNAVAILABLE',
  NO_RESPONSE: 'ADMIN_AI_NO_RESPONSE',
} as const;

export type AdminAIErrorCode = (typeof ADMIN_AI_ERROR_CODES)[keyof typeof ADMIN_AI_ERROR_CODES];

/** Base class for all admin-AI errors. */
export class AdminAIError extends Error {
  readonly code: AdminAIErrorCode;

  constructor(code: AdminAIErrorCode, message: string) {
    super(message);
    this.name = 'AdminAIError';
    this.code = code;
  }
}

/** Invalid/malformed request input. */
export class AdminAIInvalidInputError extends AdminAIError {
  constructor(message: string) {
    super(ADMIN_AI_ERROR_CODES.INVALID_INPUT, message);
    this.name = 'AdminAIInvalidInputError';
  }
}

/** The actor is not authenticated / lacks a usable admin identity. */
export class AdminAIAuthorizationError extends AdminAIError {
  constructor(message: string) {
    super(ADMIN_AI_ERROR_CODES.UNAUTHORIZED, message);
    this.name = 'AdminAIAuthorizationError';
  }
}

/** The actor is authenticated but lacks the required scope for a capability. */
export class AdminAIAccessDeniedError extends AdminAIError {
  constructor(message: string) {
    super(ADMIN_AI_ERROR_CODES.FORBIDDEN, message);
    this.name = 'AdminAIAccessDeniedError';
  }
}

/** Request was rejected for prompt-injection indicators. */
export class AdminAIInjectionError extends AdminAIError {
  constructor(message: string) {
    super(ADMIN_AI_ERROR_CODES.PROMPT_INJECTION, message);
    this.name = 'AdminAIInjectionError';
  }
}

/** An admin agent was rejected at the platform gate. */
export class AdminAgentRejectedError extends AdminAIError {
  constructor(
    message: string,
    readonly context: {
      readonly agentId: string;
      readonly taskId: string;
      readonly reasonCode?: string;
    },
  ) {
    super(ADMIN_AI_ERROR_CODES.AGENT_REJECTED, message);
    this.name = 'AdminAgentRejectedError';
  }
}

/** Demand more signal than the request supplied (honest, not an error). */
export class AdminInsufficientDataError extends AdminAIError {
  constructor(message: string) {
    super(ADMIN_AI_ERROR_CODES.INSUFFICIENT_DATA, message);
    this.name = 'AdminInsufficientDataError';
  }
}

/** Reasoning paths (agentic summaries) were requested but not configured. */
export class AdminReasoningUnavailableError extends AdminAIError {
  constructor(message: string) {
    super(ADMIN_AI_ERROR_CODES.REASONING_UNAVAILABLE, message);
    this.name = 'AdminReasoningUnavailableError';
  }
}

/** Maps a coordination failure into a typed admin-AI error. */
export function toAdminAIError(error: unknown): AdminAIError {
  if (error instanceof AdminAIError) {
    return error;
  }
  if (error instanceof CoordinationTimeoutError) {
    return new AdminAIError(ADMIN_AI_ERROR_CODES.COORDINATION_TIMEOUT, error.message);
  }
  if (error instanceof CoordinationAgentRejectedError) {
    return new AdminAgentRejectedError(error.message, {
      agentId: (error as { agentId?: string }).agentId ?? 'unknown',
      taskId: (error as { taskId?: string }).taskId ?? 'unknown',
      reasonCode: (error as { reasonCode?: string }).reasonCode,
    });
  }
  if (error instanceof CoordinationError) {
    return new AdminAIError(ADMIN_AI_ERROR_CODES.COORDINATION_FAILED, error.message);
  }
  if (error instanceof Error) {
    return new AdminAIError(ADMIN_AI_ERROR_CODES.COORDINATION_FAILED, error.message);
  }
  return new AdminAIError(ADMIN_AI_ERROR_CODES.COORDINATION_FAILED, 'Admin AI coordination failed');
}
