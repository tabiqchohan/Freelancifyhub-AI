import type { RouteCandidate, RouteDecision, RouteFallback } from '../types/index.js';
import { RoutingStatus } from '../types/index.js';
import { sortCandidates } from '../strategies/index.js';

/** Inputs needed to compute fallback routing (prompt §10). */
export interface FallbackInput {
  readonly candidates: readonly RouteCandidate[];
  readonly selectedAgent?: RouteDecision['selectedAgent'];
  readonly enabled: boolean;
  readonly excludedAgentIds: ReadonlySet<string>;
  /** Agent ids that are currently available (from the registry). */
  readonly availableAgentIds: ReadonlySet<string>;
}

/** Result of fallback resolution (prompt §10). */
export interface FallbackResult {
  readonly fallbacks: readonly RouteFallback[];
  readonly selectedAgent?: RouteDecision['selectedAgent'];
  readonly status: RoutingStatus;
  /** True when a fallback was needed but no available candidate existed. */
  readonly fallbackRequired: boolean;
}

/**
 * Deterministic fallback handling (prompt §10). When the preferred agent is
 * unavailable or excluded, the next-ranked available candidate becomes the
 * selected fallback agent. Every fallback records why it occurred; the engine
 * never silently routes somewhere else. When no fallback exists the result is
 * reported so the engine can escalate (AGENT_UNAVAILABLE).
 */
export function resolveFallbacks(input: FallbackInput): FallbackResult {
  if (!input.enabled || input.selectedAgent === undefined) {
    return {
      fallbacks: [],
      selectedAgent: input.selectedAgent,
      status: RoutingStatus.Success,
      fallbackRequired: false,
    };
  }

  const ordered = sortCandidates(input.candidates);
  const primary = ordered[0];

  if (primary === undefined) {
    return {
      fallbacks: [],
      selectedAgent: input.selectedAgent,
      status: RoutingStatus.Success,
      fallbackRequired: false,
    };
  }

  const primaryUnavailable = !input.availableAgentIds.has(primary.agent.agentId);
  const primaryExcluded = input.excludedAgentIds.has(primary.agent.agentId);

  if (!primaryUnavailable && !primaryExcluded) {
    return {
      fallbacks: [],
      selectedAgent: input.selectedAgent,
      status: RoutingStatus.Success,
      fallbackRequired: false,
    };
  }

  const fallback = ordered.find(
    (candidate) =>
      candidate.agent.agentId !== primary.agent.agentId &&
      !input.excludedAgentIds.has(candidate.agent.agentId) &&
      input.availableAgentIds.has(candidate.agent.agentId),
  );

  if (fallback === undefined) {
    return {
      fallbacks: [],
      selectedAgent: input.selectedAgent,
      status: RoutingStatus.Success,
      fallbackRequired: true,
    };
  }

  const reasons: string[] = [];
  if (primaryUnavailable) {
    reasons.push('primary agent unavailable');
  }
  if (primaryExcluded) {
    reasons.push('primary agent excluded');
  }

  const fallbackEntry: RouteFallback = {
    originalAgentId: primary.agent.agentId,
    fallbackAgentId: fallback.agent.agentId,
    reason: reasons.join('; '),
    confidence: fallback.confidence,
  };

  return {
    fallbacks: [fallbackEntry],
    selectedAgent: {
      agent: fallback.agent,
      score: fallback.score,
      confidence: fallback.confidence,
      strategy: fallback.strategy,
      reasons: fallback.reasons,
    },
    status: RoutingStatus.Fallback,
    fallbackRequired: false,
  };
}
