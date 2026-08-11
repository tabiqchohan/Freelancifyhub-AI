import type { RouteScoreWeights } from '../types/index.js';

/** Rounding helper to keep totals deterministic and readable. */
export function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Builds RouteScoreWeights from the configured routing config. */
export function weightsFromConfig(config: {
  readonly ROUTING_WEIGHT_INTENT: number;
  readonly ROUTING_WEIGHT_CAPABILITY: number;
  readonly ROUTING_WEIGHT_ROLE: number;
  readonly ROUTING_WEIGHT_STATUS: number;
  readonly ROUTING_WEIGHT_PRIORITY: number;
  readonly ROUTING_WEIGHT_COST: number;
  readonly ROUTING_WEIGHT_AVAILABILITY: number;
  readonly ROUTING_WEIGHT_CONSTRAINT: number;
}): RouteScoreWeights {
  return {
    intentMatch: config.ROUTING_WEIGHT_INTENT,
    capabilityMatch: config.ROUTING_WEIGHT_CAPABILITY,
    roleCompatibility: config.ROUTING_WEIGHT_ROLE,
    status: config.ROUTING_WEIGHT_STATUS,
    priority: config.ROUTING_WEIGHT_PRIORITY,
    cost: config.ROUTING_WEIGHT_COST,
    availability: config.ROUTING_WEIGHT_AVAILABILITY,
    constraintCompatibility: config.ROUTING_WEIGHT_CONSTRAINT,
  };
}

/** Whether the agent appears in the intent's supported-agent list. */
export function agentInIntent(agentId: string, supportedAgents: readonly string[]): boolean {
  return supportedAgents.includes(agentId);
}
