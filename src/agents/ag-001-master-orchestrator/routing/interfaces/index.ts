import type { AgentConfiguration } from '../../interfaces/execution-context.js';
import type { AgentId } from '../../types/index.js';
import type { AgentStatus } from '../../types/index.js';
import type { RouteDecision, RouteRequest, RouteScore, RouteScoreWeights } from '../types/index.js';
import type { RoutingConstraints } from '../types/index.js';
import type { IntentId, IntentResult, UserRole } from '../../intent/index.js';

/** Routing-time availability metadata for an agent (prompt §2). */
export interface AgentAvailability {
  readonly available: boolean;
  /** Machine-readable reason when the agent is unavailable. */
  readonly reason?: string;
}

/**
 * The minimal routing view of an agent. Composes the existing
 * {@link AgentConfiguration} contract with routing-only availability metadata;
 * it does NOT duplicate the Agent Catalog.
 */
export interface RoutableAgent {
  readonly configuration: AgentConfiguration;
  readonly availability: AgentAvailability;
}

/**
 * Registry abstraction over eligible agents. Implementations must stay
 * compatible with the Agent Catalog and expose deterministic lookups.
 */
export interface AgentRoutingRegistry {
  register(agent: RoutableAgent): void;
  unregister(agentId: AgentId): void;
  get(agentId: AgentId): RoutableAgent | undefined;
  list(): readonly RoutableAgent[];
  findCandidates(intentId: IntentId): readonly RoutableAgent[];
  validateAgent(agent: RoutableAgent): boolean;
}

/** Contract any deterministic route scorer must satisfy (prompt §6). */
export interface RouteScorer {
  readonly name: string;
  readonly weights: RouteScoreWeights;
  score(input: ScoreInput): RouteScore;
}

/** Inputs a scorer needs to compute a deterministic score. */
export interface ScoreInput {
  readonly agent: RoutableAgent;
  readonly intent: IntentResult;
  readonly role: UserRole;
  readonly constraints?: RoutingConstraints;
}

/** Contract any routing engine must satisfy (prompt §7/§8). */
export interface RoutingEngine {
  readonly name: string;
  readonly version: string;
  route(input: RouteRequest): RouteDecision;
}

export type { AgentConfiguration, AgentStatus, AgentId };
