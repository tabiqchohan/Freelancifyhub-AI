import { IntentPriority } from '../../intent/index.js';
import { AgentStatus } from '../../types/index.js';
import type { AgentConfiguration } from '../../interfaces/execution-context.js';
import type { RouteScore, RouteScoreWeights } from '../types/index.js';
import type { RouteScorer, ScoreInput } from '../interfaces/index.js';
import {
  constraintViolations,
  hasCapability,
  isSupportedAgent,
  requiredCapabilities,
} from '../matchers/index.js';

/** Deterministic status score derived from the catalog lifecycle (prompt §6). */
const STATUS_SCORES: Readonly<Record<AgentStatus, number>> = {
  [AgentStatus.Production]: 1,
  [AgentStatus.Testing]: 0.9,
  [AgentStatus.InDevelopment]: 0.8,
  [AgentStatus.Maintenance]: 0.7,
  [AgentStatus.Draft]: 0.3,
  [AgentStatus.Retired]: 0,
};

/** Deterministic priority score derived from the intent priority (spec §5). */
const PRIORITY_SCORES: Readonly<Record<IntentPriority, number>> = {
  [IntentPriority.Critical]: 1,
  [IntentPriority.High]: 0.8,
  [IntentPriority.Medium]: 0.6,
  [IntentPriority.Low]: 0.4,
};

const SCORER_NAME = 'deterministic-route-scorer';

/**
 * Weighted, deterministic scoring model (prompt §6).
 *
 * score = Σ weightᵢ · factorᵢ, each factor in [0,1]:
 *   intentMatch            — agent is in the intent's supported-agent list
 *   capabilityMatch        — agent declares the required capability
 *   roleCompatibility      — the user role is allowed by the intent
 *   status                 — lifecycle status (Production=1 … Retired=0)
 *   priority               — intent priority (Critical=1 … Low=0.4)
 *   cost                   — reserved; agents declare no cost in Sprint 4 (1.0)
 *   availability           — agent availability metadata (1 available)
 *   constraintCompatibility— no constraint violations (1) else 0
 *
 * No randomness, no time dependence: the same inputs always yield the same
 * total. Weights are supplied by configuration and must sum to 1.
 */
export class DeterministicRouteScorer implements RouteScorer {
  readonly name = SCORER_NAME;

  constructor(readonly weights: RouteScoreWeights) {}

  score(input: ScoreInput): RouteScore {
    const { agent, intent, role } = input;

    const breakdown = {
      intentMatch: this.intentMatch(agent.configuration, intent),
      capabilityMatch: this.capabilityMatch(agent.configuration, intent),
      roleCompatibility: this.roleCompatibility(intent, role),
      status: STATUS_SCORES[agent.configuration.status] ?? 0,
      priority: PRIORITY_SCORES[intent.primary.intent.priority] ?? 0.4,
      cost: 1,
      availability: agent.availability.available ? 1 : 0,
      constraintCompatibility: constraintViolations(agent, input.constraints).length === 0 ? 1 : 0,
    };

    const total = this.weightedTotal(breakdown);

    return { total, breakdown, weights: this.weights };
  }

  private intentMatch(agent: AgentConfiguration, intent: ScoreInput['intent']): number {
    return isSupportedAgent(agent, intent.primary.intent.supportedAgents) ? 1 : 0;
  }

  private capabilityMatch(agent: AgentConfiguration, intent: ScoreInput['intent']): number {
    const required = requiredCapabilities(intent.primary.intent.id);

    if (required.length === 0) {
      return 0;
    }

    return required.some((id) => hasCapability(agent, id)) ? 1 : 0;
  }

  private roleCompatibility(intent: ScoreInput['intent'], role: ScoreInput['role']): number {
    return intent.primary.intent.allowedRoles.includes(role) ? 1 : 0;
  }

  private weightedTotal(breakdown: RouteScore['breakdown']): number {
    return (
      this.weights.intentMatch * breakdown.intentMatch +
      this.weights.capabilityMatch * breakdown.capabilityMatch +
      this.weights.roleCompatibility * breakdown.roleCompatibility +
      this.weights.status * breakdown.status +
      this.weights.priority * breakdown.priority +
      this.weights.cost * breakdown.cost +
      this.weights.availability * breakdown.availability +
      this.weights.constraintCompatibility * breakdown.constraintCompatibility
    );
  }
}
