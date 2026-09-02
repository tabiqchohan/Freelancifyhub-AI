/** Typed errors for the production runtime agent layer (Phase 2-4). */

export const RUNTIME_AGENT_ERROR_CODES = {
  DUPLICATE_AGENT_ID: 'DUPLICATE_AGENT_ID',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_UNAVAILABLE: 'AGENT_UNAVAILABLE',
  AGENT_EXECUTION_INVALID_INPUT: 'AGENT_EXECUTION_INVALID_INPUT',
  AGENT_MALFORMED_RESULT: 'AGENT_MALFORMED_RESULT',
} as const;

export type RuntimeAgentErrorCode = keyof typeof RUNTIME_AGENT_ERROR_CODES;

/** Base typed error thrown by the runtime layer (never crosses the API). */
export class RuntimeAgentError extends Error {
  readonly code: RuntimeAgentErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: RuntimeAgentErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'RuntimeAgentError';
    this.code = code;
    this.details = details;
  }
}

/** Thrown when a duplicate agent id is registered. */
export class AgentRegistryError extends RuntimeAgentError {}
