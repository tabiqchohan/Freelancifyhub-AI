import type { IntentResult } from '../../intent/index.js';
import type { RouteCandidate, RouteDecision, RoutingConstraints } from '../types/index.js';
import { ConfidenceLevel, ExecutionMode, RoutingStatus, RoutingStrategy } from '../types/index.js';

/** Deterministic sort of candidates: score desc, then stable by agent id. */
export function sortCandidates(candidates: readonly RouteCandidate[]): RouteCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.confidence !== b.confidence) {
      return b.confidence - a.confidence;
    }
    return a.agent.agentId.localeCompare(b.agent.agentId);
  });
}

/** Maps a total confidence to a level using the spec §5 thresholds. */
export function toConfidenceLevel(confidence: number, low: number, high: number): ConfidenceLevel {
  if (confidence >= high) {
    return ConfidenceLevel.High;
  }
  if (confidence >= low) {
    return ConfidenceLevel.Medium;
  }
  return ConfidenceLevel.Low;
}

/** Chooses the routing strategy for the decision (prompt §7). */
export function resolveStrategy(input: {
  readonly intent: IntentResult;
  readonly candidates: readonly RouteCandidate[];
  readonly status: RoutingStatus;
  readonly confidence: number;
  readonly lowThreshold: number;
}): RoutingStrategy {
  if (input.status === RoutingStatus.Escalated) {
    return RoutingStrategy.Escalation;
  }

  const primary = input.candidates[0];

  if (input.status === RoutingStatus.Fallback) {
    return RoutingStrategy.Fallback;
  }

  if (input.candidates.length === 0) {
    return RoutingStrategy.Escalation;
  }

  if (input.candidates.length === 1 && input.confidence >= input.lowThreshold) {
    return RoutingStrategy.Direct;
  }

  if (primary !== undefined && input.intent.primary.intent.priority !== undefined) {
    return RoutingStrategy.Priority;
  }

  return RoutingStrategy.CapabilityMatch;
}

/** Resolves the execution mode described by the decision (prompt §9). */
export function resolveExecutionMode(
  candidates: readonly RouteCandidate[],
  multiAgentEnabled: boolean,
): ExecutionMode {
  if (candidates.length <= 1 || !multiAgentEnabled) {
    return ExecutionMode.Single;
  }

  if (candidates.length > 3) {
    return ExecutionMode.Hybrid;
  }

  return ExecutionMode.Parallel;
}

/** Caps the candidate list to the effective maximum (prompt §13). */
export function applyCandidateLimit(
  candidates: readonly RouteCandidate[],
  constraints: RoutingConstraints | undefined,
  configuredMax: number,
): RouteCandidate[] {
  const max = Math.min(constraints?.maxCandidates ?? configuredMax, configuredMax);
  return candidates.slice(0, max);
}

/** Derives a final decision summary used by the engine. */
export function summarizeDecision(input: {
  readonly status: RoutingStatus;
  readonly strategy: RoutingStrategy;
  readonly executionMode: RouteDecision['executionMode'];
  readonly confidence: number;
  readonly confidenceLevel: ConfidenceLevel;
  readonly selectedAgent?: RouteDecision['selectedAgent'];
  readonly escalation?: RouteDecision['escalation'];
}): Pick<
  RouteDecision,
  | 'status'
  | 'strategy'
  | 'executionMode'
  | 'confidence'
  | 'confidenceLevel'
  | 'selectedAgent'
  | 'escalation'
> {
  return {
    status: input.status,
    strategy: input.strategy,
    executionMode: input.executionMode,
    confidence: input.confidence,
    confidenceLevel: input.confidenceLevel,
    selectedAgent: input.selectedAgent,
    escalation: input.escalation,
  };
}
