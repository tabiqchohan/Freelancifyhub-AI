/** Sprint 19 — Agent Capability Framework & Lifecycle. Typed errors. */

export const AGENT_PLATFORM_ERROR_CODES = {
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_ALREADY_REGISTERED: 'AGENT_ALREADY_REGISTERED',
  AGENT_DEFINITION_INVALID: 'AGENT_DEFINITION_INVALID',
  AGENT_VERSION_CONFLICT: 'AGENT_VERSION_CONFLICT',
  AGENT_NOT_READY: 'AGENT_NOT_READY',
  AGENT_DISABLED: 'AGENT_DISABLED',
  AGENT_TERMINATED: 'AGENT_TERMINATED',
  AGENT_LIFECYCLE_INVALID: 'AGENT_LIFECYCLE_INVALID',
  AGENT_CAPABILITY_DENIED: 'AGENT_CAPABILITY_DENIED',
  AGENT_PERMISSION_DENIED: 'AGENT_PERMISSION_DENIED',
  AGENT_EXECUTION_LIMIT_REACHED: 'AGENT_EXECUTION_LIMIT_REACHED',
  AGENT_DEPENDENCY_UNAVAILABLE: 'AGENT_DEPENDENCY_UNAVAILABLE',
  AGENT_DEPENDENCY_CYCLE: 'AGENT_DEPENDENCY_CYCLE',
} as const;

export type AgentPlatformErrorCode = keyof typeof AGENT_PLATFORM_ERROR_CODES;

/** Base typed error thrown by the Agent Platform. Never crosses the API as an
 * exception; callers normalize it into a safe {@link ExecutionError}. */
export class AgentPlatformError extends Error {
  readonly code: AgentPlatformErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: AgentPlatformErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AgentPlatformError';
    this.code = code;
    this.details = details;
  }
}

/** Agent is not registered with the platform. */
export class AgentNotFoundError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_NOT_FOUND,
      message ?? 'Agent is not registered with the agent platform',
      details,
    );
    this.name = 'AgentNotFoundError';
  }
}

/** Duplicate registration rejected. */
export class AgentAlreadyRegisteredError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_ALREADY_REGISTERED,
      message ?? 'An agent with this id is already registered',
      details,
    );
    this.name = 'AgentAlreadyRegisteredError';
  }
}

/** The agent definition failed platform validation. */
export class AgentDefinitionInvalidError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_DEFINITION_INVALID,
      message ?? 'Agent definition failed platform validation',
      details,
    );
    this.name = 'AgentDefinitionInvalidError';
  }
}

/** Same agent id registered with an incompatible definition. */
export class AgentVersionConflictError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_VERSION_CONFLICT,
      message ?? 'Agent definition conflicts with the registered version',
      details,
    );
    this.name = 'AgentVersionConflictError';
  }
}

/** Agent lifecycle does not permit execution yet / anymore. */
export class AgentNotReadyError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_NOT_READY,
      message ?? 'Agent is not ready for execution',
      details,
    );
    this.name = 'AgentNotReadyError';
  }
}

/** Agent is disabled. */
export class AgentDisabledError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(AGENT_PLATFORM_ERROR_CODES.AGENT_DISABLED, message ?? 'Agent is disabled', details);
    this.name = 'AgentDisabledError';
  }
}

/** Agent is terminated. */
export class AgentTerminatedError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(AGENT_PLATFORM_ERROR_CODES.AGENT_TERMINATED, message ?? 'Agent is terminated', details);
    this.name = 'AgentTerminatedError';
  }
}

/** A lifecycle transition was invalid. */
export class AgentLifecycleInvalidError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_LIFECYCLE_INVALID,
      message ?? 'Invalid agent lifecycle transition',
      details,
    );
    this.name = 'AgentLifecycleInvalidError';
  }
}

/** The agent does not have a required capability / execution mode. */
export class AgentCapabilityDeniedError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_CAPABILITY_DENIED,
      message ?? 'Agent capability denied',
      details,
    );
    this.name = 'AgentCapabilityDeniedError';
  }
}

/** The agent is missing a required permission. */
export class AgentPermissionDeniedError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_PERMISSION_DENIED,
      message ?? 'Agent permission denied',
      details,
    );
    this.name = 'AgentPermissionDeniedError';
  }
}

/** An agent execution limit was reached. */
export class AgentExecutionLimitReachedError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_EXECUTION_LIMIT_REACHED,
      message ?? 'Agent execution limit reached',
      details,
    );
    this.name = 'AgentExecutionLimitReachedError';
  }
}

/** A declared dependency is not available. */
export class AgentDependencyUnavailableError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_DEPENDENCY_UNAVAILABLE,
      message ?? 'Agent dependency is unavailable',
      details,
    );
    this.name = 'AgentDependencyUnavailableError';
  }
}

/** A declared dependency graph contains a cycle. */
export class AgentDependencyCycleError extends AgentPlatformError {
  constructor(message?: string, details?: Readonly<Record<string, unknown>>) {
    super(
      AGENT_PLATFORM_ERROR_CODES.AGENT_DEPENDENCY_CYCLE,
      message ?? 'Agent dependency graph contains a cycle',
      details,
    );
    this.name = 'AgentDependencyCycleError';
  }
}
