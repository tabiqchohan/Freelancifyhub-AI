/**
 * Sprint 22 — Freelancer AI Team v1. Deterministic freelancer routing.
 *
 * AG-001's detected intent is the single authority: the router maps an
 * AG-001 `IntentId` (or a direct capability task) to a fixed freelancer route.
 * The router never classifies raw text itself. Every single-agent route is
 * pre-flighted through the Sprint 20 {@link AgentSelector} so lifecycle,
 * capability, tool-allowlist and concurrency constraints are enforced before
 * any execution is attempted.
 */

import type { AgentSelector } from '../agent-platform/coordination/index.js';
import type { AgentSelection, TaskInvocation } from '../agent-platform/coordination/index.js';
import {
  FREELANCER_CAPABILITY_TARGETS,
  FREELANCER_DEFAULT_LIMITS,
  FREELANCER_INTENT_ROUTES,
} from './constants.js';
import {
  FreelancerAIError,
  FREELANCER_AI_ERROR_CODES,
  FreelancerAgentRejectedError,
} from './errors.js';
import type { FreelancerRequest, FreelancerRoute } from './types.js';

/** Dependencies for the router. */
export interface FreelancerTeamRouterOptions {
  readonly selector: AgentSelector;
}

/** Deterministic intent/capability → freelancer-route mapper. */
export class FreelancerTeamRouter {
  readonly name = 'freelancer-team-router';

  private readonly selector: AgentSelector;

  constructor(options: FreelancerTeamRouterOptions) {
    this.selector = options.selector;
  }

  /**
   * Resolves the deterministic route for a validated request. Fails closed on
   * unknown intents/capabilities and pre-flights single-agent routes.
   */
  route(request: FreelancerRequest): FreelancerRoute {
    if (request.task !== undefined) {
      const target = FREELANCER_CAPABILITY_TARGETS[request.task.capabilityId];
      if (target === undefined) {
        throw new FreelancerAIError(
          FREELANCER_AI_ERROR_CODES.UNKNOWN_CAPABILITY,
          `Capability '${request.task.capabilityId}' is not served by the freelancer team`,
        );
      }
      const task = buildInvocation(request, {
        taskId: 'freelancer-capability',
        agentId: target.agentId,
        capabilityId: target.capabilityId,
        requiredTools: request.task.requiredTools ?? [],
      });
      this.assertSelected(this.selector.select(task));
      return { kind: 'single', agentId: target.agentId, capabilityId: target.capabilityId };
    }

    const intent = request.intent;
    if (intent === undefined) {
      throw new FreelancerAIError(
        FREELANCER_AI_ERROR_CODES.INVALID_INPUT,
        'Both intent and task are missing — a Freelancer AI request needs one of them',
      );
    }
    const routeDefinition = FREELANCER_INTENT_ROUTES[intent];
    if (routeDefinition === undefined) {
      throw new FreelancerAIError(
        FREELANCER_AI_ERROR_CODES.UNKNOWN_INTENT,
        `Intent '${intent}' has no freelancer-team workflow; only profile.optimize / proposal.generate / project.match / career.advice are served`,
      );
    }
    if (routeDefinition.kind === 'single') {
      const task = buildInvocation(request, {
        taskId: 'freelancer-intent',
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
      throw new FreelancerAgentRejectedError(
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
  request: FreelancerRequest,
  target: {
    readonly taskId: string;
    readonly agentId: string;
    readonly capabilityId: string;
    readonly requiredTools: readonly string[];
  },
): TaskInvocation {
  const timeoutMs = request.limits?.timeoutMs ?? FREELANCER_DEFAULT_LIMITS.defaultTaskTimeoutMs;
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
