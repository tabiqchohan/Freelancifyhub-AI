import { OrchestratorError, type OrchestratorErrorOptions } from '../../errors/index.js';

/**
 * Base error for the routing engine. Also the structured error type carried on
 * routing results (prompt §15).
 */
export class RoutingError extends OrchestratorError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'ROUTING_ERROR' });
  }
}

/** Raised when routing input fails validation. */
export class RoutingValidationError extends RoutingError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'ROUTING_VALIDATION_ERROR' });
  }
}

/** Raised when the routing registry is inconsistent or invalid. */
export class RoutingRegistryError extends RoutingError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'ROUTING_REGISTRY_ERROR' });
  }
}

/** Raised when routing succeeds structurally but yields no routable agent. */
export class NoRouteError extends RoutingError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'NO_ROUTE_ERROR' });
  }
}

/** Raised when routing confidence is below the accepted threshold. */
export class LowConfidenceRouteError extends RoutingError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'LOW_CONFIDENCE_ROUTE_ERROR',
      retryable: true,
    });
  }
}

/** Raised when the preferred agent is unavailable. */
export class AgentUnavailableError extends RoutingError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'AGENT_UNAVAILABLE_ERROR',
      retryable: true,
    });
  }
}

/** Raised when routing constraints cannot be satisfied. */
export class RoutingConstraintError extends RoutingError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'ROUTING_CONSTRAINT_ERROR' });
  }
}

/** Raised when the routing configuration is invalid. */
export class RoutingConfigError extends RoutingError {
  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'ROUTING_CONFIG_ERROR' });
  }
}
