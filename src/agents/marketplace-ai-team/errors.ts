/**
 * Sprint 23 — Marketplace AI Team v1. Typed, deterministic domain errors.
 *
 * Every error carries a stable machine-readable code and a safe message that
 * never embeds secrets, prompts or untrusted marketplace content verbatim.
 * Marketplace content is always untrusted (Sprint 23 §22).
 */

import {
  CoordinationAgentRejectedError,
  CoordinationError,
  CoordinationTimeoutError,
} from '../agent-platform/coordination/errors.js';

/** Stable, machine-readable marketplace-AI error codes. */
export const MARKETPLACE_AI_ERROR_CODES = {
  INVALID_INPUT: 'MARKETPLACE_AI_INVALID_INPUT',
  UNKNOWN_INTENT: 'MARKETPLACE_AI_UNKNOWN_INTENT',
  UNKNOWN_CAPABILITY: 'MARKETPLACE_AI_UNKNOWN_CAPABILITY',
  UNAUTHORIZED: 'MARKETPLACE_AI_UNAUTHORIZED',
  PROMPT_INJECTION: 'MARKETPLACE_AI_PROMPT_INJECTION',
  AGENT_REJECTED: 'MARKETPLACE_AI_AGENT_REJECTED',
  COORDINATION_FAILED: 'MARKETPLACE_AI_COORDINATION_FAILED',
  COORDINATION_TIMEOUT: 'MARKETPLACE_AI_COORDINATION_TIMEOUT',
  CANCELLED: 'MARKETPLACE_AI_CANCELLED',
  INSUFFICIENT_DATA: 'MARKETPLACE_AI_INSUFFICIENT_DATA',
  NO_RESPONSE: 'MARKETPLACE_AI_NO_RESPONSE',
} as const;

export type MarketplaceAIErrorCode =
  (typeof MARKETPLACE_AI_ERROR_CODES)[keyof typeof MARKETPLACE_AI_ERROR_CODES];

/** Base class for all marketplace-AI errors. */
export class MarketplaceAIError extends Error {
  readonly code: MarketplaceAIErrorCode;

  constructor(code: MarketplaceAIErrorCode, message: string) {
    super(message);
    this.name = 'MarketplaceAIError';
    this.code = code;
  }
}

/** Invalid/malformed request input. */
export class MarketplaceAIInvalidInputError extends MarketplaceAIError {
  constructor(message: string) {
    super(MARKETPLACE_AI_ERROR_CODES.INVALID_INPUT, message);
    this.name = 'MarketplaceAIInvalidInputError';
  }
}

/** The actor is not authorized for the requested capability. */
export class MarketplaceAIAuthorizationError extends MarketplaceAIError {
  constructor(message: string) {
    super(MARKETPLACE_AI_ERROR_CODES.UNAUTHORIZED, message);
    this.name = 'MarketplaceAIAuthorizationError';
  }
}

/** Request was rejected for prompt-injection indicators. */
export class MarketplaceAIInjectionError extends MarketplaceAIError {
  constructor(message: string) {
    super(MARKETPLACE_AI_ERROR_CODES.PROMPT_INJECTION, message);
    this.name = 'MarketplaceAIInjectionError';
  }
}

/** A marketplace agent was rejected at the platform gate. */
export class MarketplaceAgentRejectedError extends MarketplaceAIError {
  constructor(
    message: string,
    readonly context: {
      readonly agentId: string;
      readonly taskId: string;
      readonly reasonCode?: string;
    },
  ) {
    super(MARKETPLACE_AI_ERROR_CODES.AGENT_REJECTED, message);
    this.name = 'MarketplaceAgentRejectedError';
  }
}

/** Demand more signal than the request supplied (fail-open, not an error). */
export class MarketplaceInsufficientDataError extends MarketplaceAIError {
  constructor(message: string) {
    super(MARKETPLACE_AI_ERROR_CODES.INSUFFICIENT_DATA, message);
    this.name = 'MarketplaceInsufficientDataError';
  }
}

/** Maps a coordination failure into a typed marketplace-AI error. */
export function toMarketplaceAIError(error: unknown): MarketplaceAIError {
  if (error instanceof MarketplaceAIError) {
    return error;
  }
  if (error instanceof CoordinationTimeoutError) {
    return new MarketplaceAIError(MARKETPLACE_AI_ERROR_CODES.COORDINATION_TIMEOUT, error.message);
  }
  if (error instanceof CoordinationAgentRejectedError) {
    return new MarketplaceAgentRejectedError(error.message, {
      agentId: (error as { agentId?: string }).agentId ?? 'unknown',
      taskId: (error as { taskId?: string }).taskId ?? 'unknown',
      reasonCode: (error as { reasonCode?: string }).reasonCode,
    });
  }
  if (error instanceof CoordinationError) {
    return new MarketplaceAIError(MARKETPLACE_AI_ERROR_CODES.COORDINATION_FAILED, error.message);
  }
  if (error instanceof Error) {
    return new MarketplaceAIError(MARKETPLACE_AI_ERROR_CODES.COORDINATION_FAILED, error.message);
  }
  return new MarketplaceAIError(
    MARKETPLACE_AI_ERROR_CODES.COORDINATION_FAILED,
    'Marketplace AI coordination failed',
  );
}
