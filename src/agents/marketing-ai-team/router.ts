/**
 * Sprint 24 — Marketing AI Team v1. Deterministic marketing routing.
 *
 * AG-001's detected intent is the single authority: the router maps an
 * AG-001 `IntentId` (or a direct capability task) to a fixed marketing route.
 * The router never classifies raw text itself. Every single-agent route is
 * pre-flighted through the Sprint 20 {@link AgentSelector} so lifecycle,
 * capability, tool-allowlist and concurrency constraints are enforced before
 * any execution is attempted.
 */

import type { AgentSelector } from '../agent-platform/coordination/index.js';
import type { AgentSelection, TaskInvocation } from '../agent-platform/coordination/index.js';
import {
  MARKETING_CAPABILITY_TARGETS,
  MARKETING_DEFAULT_LIMITS,
  MARKETING_INTENT_ROUTES,
} from './constants.js';
import {
  MarketingAIError,
  MARKETING_AI_ERROR_CODES,
  MarketingAgentRejectedError,
} from './errors.js';
import type { MarketingRequest, MarketingRoute } from './types.js';

/** Dependencies for the router. */
export interface MarketingTeamRouterOptions {
  readonly selector: AgentSelector;
}

/** Deterministic intent/capability → marketing-route mapper. */
export class MarketingTeamRouter {
  readonly name = 'marketing-team-router';

  private readonly selector: AgentSelector;

  constructor(options: MarketingTeamRouterOptions) {
    this.selector = options.selector;
  }

  /**
   * Resolves the deterministic route for a validated request. Fails closed on
   * unknown intents/capabilities and pre-flights single-agent routes.
   */
  route(request: MarketingRequest): MarketingRoute {
    if (request.task !== undefined) {
      const target = MARKETING_CAPABILITY_TARGETS[request.task.capabilityId];
      if (target === undefined) {
        throw new MarketingAIError(
          MARKETING_AI_ERROR_CODES.UNKNOWN_CAPABILITY,
          `Capability '${request.task.capabilityId}' is not served by the marketing team`,
        );
      }
      const task = buildInvocation(request, {
        taskId: 'marketing-capability',
        agentId: target.agentId,
        capabilityId: target.capabilityId,
        requiredTools: request.task.requiredTools ?? [],
      });
      this.assertSelected(this.selector.select(task));
      return { kind: 'single', agentId: target.agentId, capabilityId: target.capabilityId };
    }

    const intent = request.intent;
    if (intent === undefined) {
      throw new MarketingAIError(
        MARKETING_AI_ERROR_CODES.INVALID_INPUT,
        'Both intent and task are missing — a Marketing AI request needs one of them',
      );
    }
    const routeDefinition = MARKETING_INTENT_ROUTES[intent];
    if (routeDefinition === undefined) {
      throw new MarketingAIError(
        MARKETING_AI_ERROR_CODES.UNKNOWN_INTENT,
        `Intent '${intent}' has no marketing-team route; only marketing.research / marketing.social / marketing.blog / marketing.seo / marketing.email / marketing.campaign are served`,
      );
    }
    if (routeDefinition.kind === 'single') {
      const task = buildInvocation(request, {
        taskId: 'marketing-intent',
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
      throw new MarketingAgentRejectedError(
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
  request: MarketingRequest,
  target: {
    readonly taskId: string;
    readonly agentId: string;
    readonly capabilityId: string;
    readonly requiredTools: readonly string[];
  },
): TaskInvocation {
  const timeoutMs = request.limits?.timeoutMs ?? MARKETING_DEFAULT_LIMITS.defaultTaskTimeoutMs;
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
