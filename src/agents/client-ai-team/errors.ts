/**
 * Sprint 21 — Client AI Team v1. Typed, deterministic domain errors.
 *
 * Every error carries a stable machine-readable code and a safe message that
 * never embeds secrets, prompts or untrusted user content verbatim.
 */

import {
  CoordinationAgentRejectedError,
  CoordinationError,
  CoordinationTimeoutError,
} from '../agent-platform/coordination/errors.js';

/** Stable, machine-readable client-AI error codes. */
export const CLIENT_AI_ERROR_CODES = {
  INVALID_INPUT: 'CLIENT_AI_INVALID_INPUT',
  UNKNOWN_INTENT: 'CLIENT_AI_UNKNOWN_INTENT',
  UNKNOWN_CAPABILITY: 'CLIENT_AI_UNKNOWN_CAPABILITY',
  UNAUTHORIZED: 'CLIENT_AI_UNAUTHORIZED',
  PROMPT_INJECTION: 'CLIENT_AI_PROMPT_INJECTION',
  AGENT_REJECTED: 'CLIENT_AI_AGENT_REJECTED',
  COORDINATION_FAILED: 'CLIENT_AI_COORDINATION_FAILED',
  COORDINATION_TIMEOUT: 'CLIENT_AI_COORDINATION_TIMEOUT',
  CANCELLED: 'CLIENT_AI_CANCELLED',
  NO_RESPONSE: 'CLIENT_AI_NO_RESPONSE',
} as const;

export type ClientAIErrorCode = (typeof CLIENT_AI_ERROR_CODES)[keyof typeof CLIENT_AI_ERROR_CODES];

/** Base class for all client-AI errors. */
export class ClientAIError extends Error {
  readonly code: ClientAIErrorCode;

  constructor(code: ClientAIErrorCode, message: string) {
    super(message);
    this.name = 'ClientAIError';
    this.code = code;
  }
}

/** Invalid/malformed request input. */
export class ClientAIAuthorizationError extends ClientAIError {
  constructor(message: string) {
    super(CLIENT_AI_ERROR_CODES.UNAUTHORIZED, message);
    this.name = 'ClientAIAuthorizationError';
  }
}

/** Request was rejected for prompt-injection indicators. */
export class ClientAIInjectionError extends ClientAIError {
  constructor(message: string) {
    super(CLIENT_AI_ERROR_CODES.PROMPT_INJECTION, message);
    this.name = 'ClientAIInjectionError';
  }
}

/** A client agent was rejected at the platform gate. */
export class ClientAgentRejectedError extends ClientAIError {
  constructor(
    message: string,
    readonly context: {
      readonly agentId: string;
      readonly taskId: string;
      readonly reasonCode?: string;
    },
  ) {
    super(CLIENT_AI_ERROR_CODES.AGENT_REJECTED, message);
    this.name = 'ClientAgentRejectedError';
  }
}

/** Maps a coordination failure into a typed client-AI error. */
export function toClientAIError(error: unknown): ClientAIError {
  if (error instanceof ClientAIError) {
    return error;
  }
  if (error instanceof CoordinationTimeoutError) {
    return new ClientAIError(CLIENT_AI_ERROR_CODES.COORDINATION_TIMEOUT, error.message);
  }
  if (error instanceof CoordinationAgentRejectedError) {
    return new ClientAgentRejectedError(error.message, {
      agentId: (error as { agentId?: string }).agentId ?? 'unknown',
      taskId: (error as { taskId?: string }).taskId ?? 'unknown',
      reasonCode: (error as { reasonCode?: string }).reasonCode,
    });
  }
  if (error instanceof CoordinationError) {
    return new ClientAIError(CLIENT_AI_ERROR_CODES.COORDINATION_FAILED, error.message);
  }
  if (error instanceof Error) {
    return new ClientAIError(CLIENT_AI_ERROR_CODES.COORDINATION_FAILED, error.message);
  }
  return new ClientAIError(
    CLIENT_AI_ERROR_CODES.COORDINATION_FAILED,
    'Client AI coordination failed',
  );
}
