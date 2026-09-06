/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. Public barrel.
 *
 * The platform is a formal contract layer for agent identity, capability,
 * permission, execution-mode, limits, lifecycle, and execution admission. It
 * sits on top of AG-001 and the Agent Catalog; it never replaces them.
 */

// Constants (stable, server-controlled identifiers).
export * from './constants.js';

// Typed errors (all subclasses of AgentPlatformError).
export { AGENT_PLATFORM_ERROR_CODES } from './errors.js';
export type { AgentPlatformErrorCode } from './errors.js';
export {
  AgentPlatformError,
  AgentNotFoundError,
  AgentAlreadyRegisteredError,
  AgentDefinitionInvalidError,
  AgentVersionConflictError,
  AgentNotReadyError,
  AgentDisabledError,
  AgentTerminatedError,
  AgentLifecycleInvalidError,
  AgentCapabilityDeniedError,
  AgentPermissionDeniedError,
  AgentExecutionLimitReachedError,
  AgentDependencyUnavailableError,
  AgentDependencyCycleError,
} from './errors.js';

// Domain contracts and Zod validation.
export * from './types.js';
export {
  agentIdSchema,
  agentVersionSchema,
  agentCapabilitySchema,
  agentExecutionModeSchema,
  agentPermissionSchema,
  agentToolNameSchema,
  agentDependencySchema,
  agentLimitsInputSchema,
  agentDefinitionSchema,
  parseAgentDefinition,
  isValidAgentDefinition,
  capability,
} from './schemas.js';

// Observable event trail.
export * from './events.js';

// Lifecycle state machine and controller.
export * from './lifecycle.js';

// Deterministic metrics.
export * from './metrics.js';

// Definition registry (ownership + discovery + health snapshot).
export * from './registry.js';

// Execution gate.
export * from './gateway.js';

// AG-001 routing integration.
export * from './routing.js';

// Built-in definitions.
export * from './builtin.js';
