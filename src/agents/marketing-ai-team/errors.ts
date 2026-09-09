/**
 * Sprint 24 — Marketing AI Team v1. Typed, deterministic domain errors.
 *
 * Every error carries a stable machine-readable code and a safe message that
 * never embeds secrets, prompts or untrusted marketing content verbatim.
 * Marketing content is always untrusted (Sprint 24 §6).
 */

import {
  CoordinationAgentRejectedError,
  CoordinationError,
  CoordinationTimeoutError,
} from '../agent-platform/coordination/errors.js';

/** Stable, machine-readable marketing-AI error codes. */
export const MARKETING_AI_ERROR_CODES = {
  INVALID_INPUT: 'MARKETING_AI_INVALID_INPUT',
  UNKNOWN_INTENT: 'MARKETING_AI_UNKNOWN_INTENT',
  UNKNOWN_CAPABILITY: 'MARKETING_AI_UNKNOWN_CAPABILITY',
  UNAUTHORIZED: 'MARKETING_AI_UNAUTHORIZED',
  PROMPT_INJECTION: 'MARKETING_AI_PROMPT_INJECTION',
  AGENT_REJECTED: 'MARKETING_AI_AGENT_REJECTED',
  COORDINATION_FAILED: 'MARKETING_AI_COORDINATION_FAILED',
  COORDINATION_TIMEOUT: 'MARKETING_AI_COORDINATION_TIMEOUT',
  CANCELLED: 'MARKETING_AI_CANCELLED',
  INSUFFICIENT_DATA: 'MARKETING_AI_INSUFFICIENT_DATA',
  NO_RESPONSE: 'MARKETING_AI_NO_RESPONSE',
} as const;

export type MarketingAIErrorCode =
  (typeof MARKETING_AI_ERROR_CODES)[keyof typeof MARKETING_AI_ERROR_CODES];

/** Base class for all marketing-AI errors. */
export class MarketingAIError extends Error {
  readonly code: MarketingAIErrorCode;

  constructor(code: MarketingAIErrorCode, message: string) {
    super(message);
    this.name = 'MarketingAIError';
    this.code = code;
  }
}

/** Invalid/malformed request input. */
export class MarketingAIInvalidInputError extends MarketingAIError {
  constructor(message: string) {
    super(MARKETING_AI_ERROR_CODES.INVALID_INPUT, message);
    this.name = 'MarketingAIInvalidInputError';
  }
}

/** The actor is not authorized for the requested capability. */
export class MarketingAIAuthorizationError extends MarketingAIError {
  constructor(message: string) {
    super(MARKETING_AI_ERROR_CODES.UNAUTHORIZED, message);
    this.name = 'MarketingAIAuthorizationError';
  }
}

/** Request was rejected for prompt-injection indicators. */
export class MarketingAIInjectionError extends MarketingAIError {
  constructor(message: string) {
    super(MARKETING_AI_ERROR_CODES.PROMPT_INJECTION, message);
    this.name = 'MarketingAIInjectionError';
  }
}

/** A marketing agent was rejected at the platform gate. */
export class MarketingAgentRejectedError extends MarketingAIError {
  constructor(
    message: string,
    readonly context: {
      readonly agentId: string;
      readonly taskId: string;
      readonly reasonCode?: string;
    },
  ) {
    super(MARKETING_AI_ERROR_CODES.AGENT_REJECTED, message);
    this.name = 'MarketingAgentRejectedError';
  }
}

/** Demand more signal than the request supplied (honest, not an error). */
export class MarketingInsufficientDataError extends MarketingAIError {
  constructor(message: string) {
    super(MARKETING_AI_ERROR_CODES.INSUFFICIENT_DATA, message);
    this.name = 'MarketingInsufficientDataError';
  }
}

/** Maps a coordination failure into a typed marketing-AI error. */
export function toMarketingAIError(error: unknown): MarketingAIError {
  if (error instanceof MarketingAIError) {
    return error;
  }
  if (error instanceof CoordinationTimeoutError) {
    return new MarketingAIError(MARKETING_AI_ERROR_CODES.COORDINATION_TIMEOUT, error.message);
  }
  if (error instanceof CoordinationAgentRejectedError) {
    return new MarketingAgentRejectedError(error.message, {
      agentId: (error as { agentId?: string }).agentId ?? 'unknown',
      taskId: (error as { taskId?: string }).taskId ?? 'unknown',
      reasonCode: (error as { reasonCode?: string }).reasonCode,
    });
  }
  if (error instanceof CoordinationError) {
    return new MarketingAIError(MARKETING_AI_ERROR_CODES.COORDINATION_FAILED, error.message);
  }
  if (error instanceof Error) {
    return new MarketingAIError(MARKETING_AI_ERROR_CODES.COORDINATION_FAILED, error.message);
  }
  return new MarketingAIError(
    MARKETING_AI_ERROR_CODES.COORDINATION_FAILED,
    'Marketing AI coordination failed',
  );
}
