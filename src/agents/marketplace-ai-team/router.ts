/**
 * Sprint 23 — Marketplace AI Team v1. Deterministic marketplace routing.
 *
 * AG-001's detected intent is the single authority: the router maps an
 * AG-001 `IntentId` (or a direct capability task) to a fixed marketplace
 * route. The router never classifies raw text itself. Every single-agent
 * route is pre-flighted through the Sprint 20 {@link AgentSelector} so
 * lifecycle, capability, tool-allowlist and concurrency constraints are
 * enforced before any execution is attempted.
 */

import type { AgentSelector } from '../agent-platform/coordination/index.js';
import type { AgentSelection, TaskInvocation } from '../agent-platform/coordination/index.js';
import {
  MARKETPLACE_CAPABILITY_TARGETS,
  MARKETPLACE_DEFAULT_LIMITS,
  MARKETPLACE_INTENT_ROUTES,
} from './constants.js';
import {
  MarketplaceAIError,
  MARKETPLACE_AI_ERROR_CODES,
  MarketplaceAgentRejectedError,
} from './errors.js';
import type { MarketplaceRequest, MarketplaceRoute } from './types.js';

/** Dependencies for the router. */
export interface MarketplaceTeamRouterOptions {
  readonly selector: AgentSelector;
}

/** Deterministic intent/capability → marketplace-route mapper. */
export class MarketplaceTeamRouter {
  readonly name = 'marketplace-team-router';

  private readonly selector: AgentSelector;

  constructor(options: MarketplaceTeamRouterOptions) {
    this.selector = options.selector;
  }

  /**
   * Resolves the deterministic route for a validated request. Fails closed on
   * unknown intents/capabilities and pre-flights single-agent routes.
   */
  route(request: MarketplaceRequest): MarketplaceRoute {
    if (request.task !== undefined) {
      const target = MARKETPLACE_CAPABILITY_TARGETS[request.task.capabilityId];
      if (target === undefined) {
        throw new MarketplaceAIError(
          MARKETPLACE_AI_ERROR_CODES.UNKNOWN_CAPABILITY,
          `Capability '${request.task.capabilityId}' is not served by the marketplace team`,
        );
      }
      const task = buildInvocation(request, {
        taskId: 'marketplace-capability',
        agentId: target.agentId,
        capabilityId: target.capabilityId,
        requiredTools: request.task.requiredTools ?? [],
      });
      this.assertSelected(this.selector.select(task));
      return { kind: 'single', agentId: target.agentId, capabilityId: target.capabilityId };
    }

    const intent = request.intent;
    if (intent === undefined) {
      throw new MarketplaceAIError(
        MARKETPLACE_AI_ERROR_CODES.INVALID_INPUT,
        'Both intent and task are missing — a Marketplace AI request needs one of them',
      );
    }
    const routeDefinition = MARKETPLACE_INTENT_ROUTES[intent];
    if (routeDefinition === undefined) {
      throw new MarketplaceAIError(
        MARKETPLACE_AI_ERROR_CODES.UNKNOWN_INTENT,
        `Intent '${intent}' has no marketplace-team route; only contract.generate / milestone.plan / review.generate / scam.report / dispute.open / message.send / engagement.scope are served`,
      );
    }
    if (routeDefinition.kind === 'single') {
      const task = buildInvocation(request, {
        taskId: 'marketplace-intent',
        agentId: routeDefinition.agentId,
        capabilityId: routeDefinition.capabilityId,
        requiredTools: [],
      });
      this.assertSelected(this.selector.select(task));
      return {
        kind: 'single',
        agentId: routeDefinition.agentId,
        capabilityId: routeDefinition.capabilityId,
      };
    }
    return { kind: 'workflow', workflowId: routeDefinition.workflowId };
  }

  private assertSelected(selection: AgentSelection): void {
    if (!selection.selected) {
      throw new MarketplaceAgentRejectedError(
        `Agent ${selection.agentId} rejected for task ${selection.taskId}: ${selection.message}`,
        {
          agentId: selection.agentId,
          taskId: selection.taskId,
          reasonCode: selection.reasonCode,
        },
      );
    }
  }
}

function buildInvocation(
  request: MarketplaceRequest,
  target: {
    readonly taskId: string;
    readonly agentId: string;
    readonly capabilityId: string;
    readonly requiredTools: readonly string[];
  },
): TaskInvocation {
  const timeoutMs = request.limits?.timeoutMs ?? MARKETPLACE_DEFAULT_LIMITS.defaultTaskTimeoutMs;
  return {
    taskId: target.taskId,
    agentId: target.agentId,
    objective: target.capabilityId,
    input: request.input,
    dependencies: [],
    requiredCapabilities: [target.capabilityId],
    requiredTools: target.requiredTools,
    priority: 0,
    timeoutMs,
    retry: {
      maxRetries: 0,
      retryable: true,
      backoffMs: 0,
      backoffMultiplier: 1,
      maxBackoffMs: 0,
    },
  };
}
