import type { Logger } from 'pino';

import { createOrchestratorLogger } from '../utils/logger.js';
import { nowIso } from '../utils/ids.js';
import { RoutingConfigError, RoutingValidationError } from './errors/index.js';
import { routingConfig, type RoutingConfig } from './config/index.js';
import { RoutingRegistry } from './registry/index.js';
import { DeterministicRouteScorer } from './scorers/index.js';
import {
  constraintViolations,
  hasCapability,
  isRoutableStatus,
  isSupportedAgent,
  requiredCapabilities,
  satisfiesConstraints,
} from './matchers/index.js';
import {
  applyCandidateLimit,
  resolveExecutionMode,
  resolveStrategy,
  sortCandidates,
  toConfidenceLevel,
} from './strategies/index.js';
import { resolveEscalation } from './escalations/index.js';
import { resolveFallbacks } from './fallback/index.js';
import { validateRouteRequest } from './validators/index.js';
import { weightsFromConfig } from './utils/index.js';
import { defaultConstraints } from './config/index.js';
import type { AgentRoutingRegistry, RouteScorer, RoutableAgent } from './interfaces/index.js';
import type {
  RouteCandidate,
  RouteDecision,
  RouteRequest,
  RouteScore,
  RouteReason,
  RoutingConstraints,
  RoutingMetadata,
} from './types/index.js';
import { EscalationReason, RoutingStatus, RoutingStrategy } from './types/index.js';
import type { IntentId } from '../intent/index.js';

/** Options for constructing the routing engine. */
export interface RoutingEngineOptions {
  readonly config?: RoutingConfig;
  readonly registry?: AgentRoutingRegistry;
  readonly scorer?: RouteScorer;
  readonly logger?: Logger;
}

/**
 * Deterministic Agent Routing Engine (Sprint 4, prompt §8). It consumes an
 * AgentRequest, IntentResult and ContextSnapshot and produces a validated
 * RouteDecision. Pure and read-only: no execution, retrieval, tools, LLM or
 * external calls. Same inputs ⇒ same decision.
 */
export class RoutingEngine {
  readonly name = 'agent-routing-engine';
  readonly version = '1.0.0';

  private readonly config: RoutingConfig;
  private readonly registry: AgentRoutingRegistry;
  private readonly scorer: RouteScorer;
  private readonly logger: Logger;

  constructor(options: RoutingEngineOptions = {}) {
    this.config = options.config ?? routingConfig;
    this.registry = options.registry ?? new RoutingRegistry();
    this.scorer = options.scorer ?? new DeterministicRouteScorer(weightsFromConfig(this.config));
    this.logger = options.logger ?? createOrchestratorLogger('routing');
  }

  /** Runs deterministic routing and returns a validated decision. */
  route(input: RouteRequest): RouteDecision {
    validateRouteRequest(input);

    const intentId = input.intent.primary.intent.id;
    const constraints = this.effectiveConstraints(input);
    const routingInput: RouteRequest = { ...input, constraints };
    const candidates = this.buildCandidates(routingInput, intentId);
    const sorted = sortCandidates(candidates);
    const limited = applyCandidateLimit(sorted, constraints, this.config.ROUTING_MAX_CANDIDATES);

    const confidence = limited[0]?.confidence ?? 0;
    const confidenceLevel = toConfidenceLevel(
      confidence,
      this.config.ROUTING_CONFIDENCE_LOW,
      this.config.ROUTING_CONFIDENCE_HIGH,
    );

    const escalation = resolveEscalation({
      intent: input.intent,
      role: input.role,
      candidates: limited,
      confidence,
      confidenceLevel,
      lowThreshold: this.config.ROUTING_CONFIDENCE_LOW,
      enabled: this.config.ROUTING_ESCALATION_ENABLED,
      allowedRoles: constraints.allowedRoles,
    });

    const reasons: RouteReason[] = [...escalation.reasons];
    let status = escalation.status;
    let strategy: RoutingStrategy;
    let selectedAgent: RouteDecision['selectedAgent'];
    let fallbacks: RouteDecision['fallbacks'] = [];
    let decisionEscalation = escalation.escalation;

    if (status === RoutingStatus.Escalated) {
      strategy = RoutingStrategy.Escalation;
    } else {
      const primary = limited[0];
      if (primary === undefined) {
        status = RoutingStatus.Escalated;
        strategy = RoutingStrategy.Escalation;
      } else {
        selectedAgent = {
          agent: primary.agent,
          score: primary.score,
          confidence: primary.confidence,
          strategy: primary.strategy,
          reasons: primary.reasons,
        };

        const fallbackResult = resolveFallbacks({
          candidates: limited,
          selectedAgent,
          enabled: this.config.ROUTING_FALLBACK_ENABLED,
          excludedAgentIds: new Set(constraints?.excludedAgents ?? []),
          availableAgentIds: this.availableAgentIds(),
        });

        fallbacks = fallbackResult.fallbacks;
        status = fallbackResult.status;
        selectedAgent = fallbackResult.selectedAgent ?? selectedAgent;
        strategy = resolveStrategy({
          intent: input.intent,
          candidates: limited,
          status,
          confidence,
          lowThreshold: this.config.ROUTING_CONFIDENCE_LOW,
        });

        if (fallbackResult.status === RoutingStatus.Fallback) {
          reasons.push({
            code: 'FALLBACK_SELECTED',
            message: 'Primary agent was not routable; a fallback candidate was selected',
            details: { fallbackCount: fallbacks.length },
          });
        } else if (fallbackResult.fallbackRequired) {
          status = RoutingStatus.Escalated;
          strategy = RoutingStrategy.Escalation;
          selectedAgent = undefined;
          decisionEscalation = {
            reason: EscalationReason.AgentUnavailable,
            message: 'Preferred agent is unavailable and no fallback agent exists',
            details: {
              agentId: primary.agent.agentId,
            },
          };
          reasons.push({
            code: 'AGENT_UNAVAILABLE',
            message: `Preferred agent ${primary.agent.agentId} is unavailable with no fallback`,
          });
        }
      }
    }

    if (status === RoutingStatus.Escalated) {
      selectedAgent = undefined;
    }

    const executionMode = resolveExecutionMode(limited, this.config.ROUTING_MULTI_AGENT_ENABLED);

    const metadata: RoutingMetadata = {
      version: this.version,
      routedAt: nowIso(),
      requestId: input.requestId,
      traceId: input.traceId,
      intentId,
      strategy,
      executionMode,
      candidateCount: limited.length,
      fallbackCount: fallbacks.length,
      escalated: status === RoutingStatus.Escalated,
    };

    this.logger.info(
      {
        requestId: input.requestId,
        traceId: input.traceId,
        intent: intentId,
        candidateCount: limited.length,
        selectedAgent: selectedAgent?.agent.agentId,
        routingStrategy: strategy,
        confidence,
        fallback: fallbacks.length > 0,
        escalation: status === RoutingStatus.Escalated,
      },
      'routing decision produced',
    );

    return {
      requestId: input.requestId,
      traceId: input.traceId,
      intentId,
      status,
      strategy,
      executionMode,
      confidence,
      confidenceLevel,
      confidenceThreshold: this.config.ROUTING_CONFIDENCE_LOW,
      selectedAgent,
      candidates: limited,
      fallbacks,
      escalation: decisionEscalation,
      reasons,
      metadata,
    };
  }

  private buildCandidates(input: RouteRequest, intentId: IntentId): RouteCandidate[] {
    const intentCapabilities = requiredCapabilities(intentId);
    const supportedAgents = input.intent.primary.intent.supportedAgents;
    const registryCandidates = this.registry.findCandidates(intentId);
    const candidates: RouteCandidate[] = [];

    const seen = new Set<string>();

    const consider = (agent: RoutableAgent): void => {
      const id = agent.configuration.agentId;

      if (seen.has(id)) {
        return;
      }

      if (!isRoutableStatus(agent.configuration)) {
        return;
      }

      const supported = isSupportedAgent(agent.configuration, supportedAgents);
      const capable =
        intentCapabilities.length > 0 &&
        intentCapabilities.some((cap) => hasCapability(agent.configuration, cap));

      if (!supported && !capable) {
        return;
      }

      if (!satisfiesConstraints(agent, input.constraints)) {
        return;
      }

      const score = this.score(agent, input);
      if (
        input.constraints?.minConfidence !== undefined &&
        score.total < input.constraints.minConfidence
      ) {
        return;
      }

      seen.add(id);

      const strategy = supported ? RoutingStrategy.Direct : RoutingStrategy.CapabilityMatch;

      candidates.push({
        agent: agent.configuration,
        score,
        confidence: score.total,
        strategy,
        reasons: this.buildReasons(agent, supported, input),
      });
    };

    for (const agent of registryCandidates) {
      consider(agent);
    }

    for (const agentId of supportedAgents) {
      const agent = this.registry.get(agentId);
      if (agent !== undefined) {
        consider(agent);
      }
    }

    return candidates;
  }

  private score(agent: RoutableAgent, input: RouteRequest): RouteScore {
    return this.scorer.score({
      agent,
      intent: input.intent,
      role: input.role,
      constraints: input.constraints,
    });
  }

  private buildReasons(
    agent: RoutableAgent,
    supported: boolean,
    input: RouteRequest,
  ): RouteReason[] {
    const reasons: RouteReason[] = [];

    if (supported) {
      reasons.push({
        code: 'INTENT_SUPPORT',
        message: `Agent ${agent.configuration.agentId} is a supported agent for the intent`,
      });
    }

    if (input.intent.primary.intent.allowedRoles.includes(input.role)) {
      reasons.push({
        code: 'ROLE_ALLOWED',
        message: `Role ${input.role} is allowed for the intent`,
      });
    }

    const violations = constraintViolations(agent, input.constraints);
    if (violations.length > 0) {
      reasons.push({
        code: 'CONSTRAINT_VIOLATION',
        message: violations.join('; '),
      });
    }

    return reasons;
  }

  private availableAgentIds(): ReadonlySet<string> {
    return new Set(
      this.registry
        .list()
        .filter((agent) => agent.availability.available && isRoutableStatus(agent.configuration))
        .map((agent) => agent.configuration.agentId),
    );
  }

  /**
   * Merges configured routing defaults into the request constraints so the
   * global ROUTING_MAX_COST ceiling is always enforced (prompt §13). The
   * request can tighten it. ROUTING_CONFIDENCE_LOW is deliberately not merged
   * as minConfidence because it already gates low-confidence escalation, and
   * maxCandidates is applied by applyCandidateLimit from configuration.
   */
  private effectiveConstraints(input: RouteRequest): RoutingConstraints {
    const defaults = defaultConstraints(this.config);
    return {
      ...input.constraints,
      maxRoutingCost: input.constraints?.maxRoutingCost ?? defaults.maxRoutingCost,
    };
  }
}

export { RoutingConfigError, RoutingValidationError };
