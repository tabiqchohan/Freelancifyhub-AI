/**
 * Sprint 22 — Freelancer AI Team v1. Typed, deterministic domain errors.
 *
 * Every error carries a stable machine-readable code and a safe message that
 * never embeds secrets, prompts or untrusted user content verbatim.
 */

import {
  CoordinationAgentRejectedError,
  CoordinationError,
  CoordinationTimeoutError,
} from '../agent-platform/coordination/errors.js';

/** Stable, machine-readable freelancer-AI error codes. */
export const FREELANCER_AI_ERROR_CODES = {
  INVALID_INPUT: 'FREELANCER_AI_INVALID_INPUT',
  UNKNOWN_INTENT: 'FREELANCER_AI_UNKNOWN_INTENT',
  UNKNOWN_CAPABILITY: 'FREELANCER_AI_UNKNOWN_CAPABILITY',
  UNAUTHORIZED: 'FREELANCER_AI_UNAUTHORIZED',
  PROMPT_INJECTION: 'FREELANCER_AI_PROMPT_INJECTION',
  AGENT_REJECTED: 'FREELANCER_AI_AGENT_REJECTED',
  COORDINATION_FAILED: 'FREELANCER_AI_COORDINATION_FAILED',
  COORDINATION_TIMEOUT: 'FREELANCER_AI_COORDINATION_TIMEOUT',
  CANCELLED: 'FREELANCER_AI_CANCELLED',
  INSUFFICIENT_DATA: 'FREELANCER_AI_INSUFFICIENT_DATA',
  NO_RESPONSE: 'FREELANCER_AI_NO_RESPONSE',
} as const;

export type FreelancerAIErrorCode =
  (typeof FREELANCER_AI_ERROR_CODES)[keyof typeof FREELANCER_AI_ERROR_CODES];

/** Base class for all freelancer-AI errors. */
export class FreelancerAIError extends Error {
  readonly code: FreelancerAIErrorCode;

  constructor(code: FreelancerAIErrorCode, message: string) {
    super(message);
    this.name = 'FreelancerAIError';
    this.code = code;
  }
}

/** Invalid/malformed request input. */
export class FreelancerAIInvalidInputError extends FreelancerAIError {
  constructor(message: string) {
    super(FREELANCER_AI_ERROR_CODES.INVALID_INPUT, message);
    this.name = 'FreelancerAIInvalidInputError';
  }
}

/** The actor is not authorized for the requested capability. */
export class FreelancerAIAuthorizationError extends FreelancerAIError {
  constructor(message: string) {
    super(FREELANCER_AI_ERROR_CODES.UNAUTHORIZED, message);
    this.name = 'FreelancerAIAuthorizationError';
  }
}

/** Request was rejected for prompt-injection indicators. */
export class FreelancerAIInjectionError extends FreelancerAIError {
  constructor(message: string) {
    super(FREELANCER_AI_ERROR_CODES.PROMPT_INJECTION, message);
    this.name = 'FreelancerAIInjectionError';
  }
}

/** A freelancer agent was rejected at the platform gate. */
export class FreelancerAgentRejectedError extends FreelancerAIError {
  constructor(
    message: string,
    readonly context: {
      readonly agentId: string;
      readonly taskId: string;
      readonly reasonCode?: string;
    },
  ) {
    super(FREELANCER_AI_ERROR_CODES.AGENT_REJECTED, message);
    this.name = 'FreelancerAgentRejectedError';
  }
}

/** Demand more signal than the request supplied (fail-open, not an error). */
export class FreelancerInsufficientDataError extends FreelancerAIError {
  constructor(message: string) {
    super(FREELANCER_AI_ERROR_CODES.INSUFFICIENT_DATA, message);
    this.name = 'FreelancerInsufficientDataError';
  }
}

/** Maps a coordination failure into a typed freelancer-AI error. */
export function toFreelancerAIError(error: unknown): FreelancerAIError {
  if (error instanceof FreelancerAIError) {
    return error;
  }
  if (error instanceof CoordinationTimeoutError) {
    return new FreelancerAIError(FREELANCER_AI_ERROR_CODES.COORDINATION_TIMEOUT, error.message);
  }
  if (error instanceof CoordinationAgentRejectedError) {
    return new FreelancerAgentRejectedError(error.message, {
      agentId: (error as { agentId?: string }).agentId ?? 'unknown',
      taskId: (error as { taskId?: string }).taskId ?? 'unknown',
      reasonCode: (error as { reasonCode?: string }).reasonCode,
    });
  }
  if (error instanceof CoordinationError) {
    return new FreelancerAIError(FREELANCER_AI_ERROR_CODES.COORDINATION_FAILED, error.message);
  }
  if (error instanceof Error) {
    return new FreelancerAIError(FREELANCER_AI_ERROR_CODES.COORDINATION_FAILED, error.message);
  }
  return new FreelancerAIError(
    FREELANCER_AI_ERROR_CODES.COORDINATION_FAILED,
    'Freelancer AI coordination failed',
  );
}
