/**
 * Sprint 25 — Admin AI Team v1. Deterministic admin routing.
 *
 * AG-001's detected intent is the single authority: the router maps an
 * AG-001 `IntentId` (or a direct capability task) to a fixed admin route.
 * The router never classifies raw text itself. Every single-agent route is
 * pre-flighted through the Sprint 20 {@link AgentSelector} so lifecycle,
 * capability, tool-allowlist and concurrency constraints are enforced before
 * any execution is attempted. Routes for privileged capabilities are later
 * scope-authorized by the service's authorization layer (BR-ADM-1).
 */

import type { AgentSelector } from '../agent-platform/coordination/index.js';
import type { AgentSelection, TaskInvocation } from '../agent-platform/coordination/index.js';
import {
  ADMIN_CAPABILITY_TARGETS,
  ADMIN_DEFAULT_LIMITS,
  ADMIN_INTENT_ROUTES,
} from './constants.js';
import { AdminAIError, ADMIN_AI_ERROR_CODES, AdminAgentRejectedError } from './errors.js';
import type { AdminRequest, AdminRoute } from './types.js';

/** Dependencies for the router. */
export interface AdminTeamRouterOptions {
  readonly selector: AgentSelector;
}

/** Deterministic intent/capability → admin-route mapper. */
export class AdminTeamRouter {
  readonly name = 'admin-team-router';

  private readonly selector: AgentSelector;

  constructor(options: AdminTeamRouterOptions) {
    this.selector = options.selector;
  }

  /**
   * Resolves the deterministic route for a validated request. Fails closed on
   * unknown intents/capabilities and pre-flights single-agent routes.
   */
  route(request: AdminRequest): AdminRoute {
    if (request.task !== undefined) {
      const target = ADMIN_CAPABILITY_TARGETS[request.task.capabilityId];
      if (target === undefined) {
        throw new AdminAIError(
          ADMIN_AI_ERROR_CODES.UNKNOWN_CAPABILITY,
          `Capability '${request.task.capabilityId}' is not served by the admin team`,
        );
      }
      const task = buildInvocation(request, {
        taskId: 'admin-capability',
        agentId: target.agentId,
        capabilityId: target.capabilityId,
        requiredTools: request.task.requiredTools ?? [],
      });
      this.assertSelected(this.selector.select(task));
      return { kind: 'single', agentId: target.agentId, capabilityId: target.capabilityId };
    }

    const intent = request.intent;
    if (intent === undefined) {
      throw new AdminAIError(
        ADMIN_AI_ERROR_CODES.INVALID_INPUT,
        'Both intent and task are missing — an Admin AI request needs one of them',
      );
    }
    const routeDefinition = ADMIN_INTENT_ROUTES[intent];
    if (routeDefinition === undefined || !intent.startsWith('admin.')) {
      throw new AdminAIError(
        ADMIN_AI_ERROR_CODES.UNKNOWN_INTENT,
        `Intent '${intent}' has no admin-team route; only admin.action / admin.analytics / admin.fraud / admin.health / admin.aiops / admin.executive are served`,
      );
    }
    if (routeDefinition.kind === 'single') {
      const task = buildInvocation(request, {
        taskId: 'admin-intent',
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
      throw new AdminAgentRejectedError(
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
  request: AdminRequest,
  target: {
    readonly taskId: string;
    readonly agentId: string;
    readonly capabilityId: string;
    readonly requiredTools: readonly string[];
  },
): TaskInvocation {
  const timeoutMs = request.limits?.timeoutMs ?? ADMIN_DEFAULT_LIMITS.defaultTaskTimeoutMs;
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
