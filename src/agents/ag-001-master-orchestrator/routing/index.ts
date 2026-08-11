export * from './errors/index.js';
export * from './types/index.js';
export {
  RoutingConfigSchema,
  parseRoutingConfig,
  routingConfig,
  defaultConstraints,
} from './config/index.js';
export type { RoutingConfig } from './config/index.js';

export type {
  AgentAvailability,
  RoutableAgent,
  AgentRoutingRegistry,
  RouteScorer,
  ScoreInput,
  RoutingEngine as RoutingEngineContract,
} from './interfaces/index.js';

export { RoutingRegistry, buildDefaultCatalog, requiredCapabilities } from './registry/index.js';

export {
  hasCapability,
  matchesIntentCapability,
  isSupportedAgent,
  isRoutableStatus,
  constraintViolations,
  satisfiesConstraints,
} from './matchers/index.js';

export { DeterministicRouteScorer } from './scorers/index.js';

export {
  sortCandidates,
  toConfidenceLevel,
  resolveStrategy,
  resolveExecutionMode,
  applyCandidateLimit,
} from './strategies/index.js';

export { resolveFallbacks } from './fallback/index.js';
export type { FallbackInput, FallbackResult } from './fallback/index.js';

export { resolveEscalation } from './escalations/index.js';
export type { EscalationInput, EscalationResult } from './escalations/index.js';

export { validateRouteRequest, validateConstraints } from './validators/index.js';

export { round, weightsFromConfig, agentInIntent } from './utils/index.js';

export { RoutingEngine } from './engine.js';
export type { RoutingEngineOptions } from './engine.js';
