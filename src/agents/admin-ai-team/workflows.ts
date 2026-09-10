/**
 * Sprint 25 — Admin AI Team v1. Admin workflow recipes.
 *
 * Deterministic coordination recipes reused by the admin service. The one
 * coordination workflow this sprint ships is the executive review: three
 * independent tasks are fanned out in PARALLEL — analytics (AG-501
 * admin.analytics), health (AG-503 admin.health) and fraud (AG-502
 * admin.fraud) — and collected into a single executive review readout for the
 * admin user. Every task carries the exact requested capability so the
 * capability-aware runtime agents dispatch to the right analyzer, and a
 * bounded `admin.scopes` copy so each determinator can re-enforce BR-ADM-1 at
 * the agent level. The coordinator, planner and selector still vet every task
 * at plan time through the Sprint 20 + Sprint 19 layers.
 */

import type { AgentSelector } from '../agent-platform/coordination/index.js';
import {
  AggregationStrategy,
  ConflictPolicy,
  CoordinationMode,
  TaskFailurePolicy,
} from '../agent-platform/coordination/index.js';
import type {
  CoordinationRequest,
  CoordinationTaskInput,
} from '../agent-platform/coordination/index.js';
import {
  ADMIN_AGENT_IDS,
  ADMIN_CAPABILITY_IDS,
  ADMIN_DEFAULT_LIMITS,
  ADMIN_EXECUTIVE_WORKFLOW,
  ADMIN_WORKFLOW_TASK_IDS,
} from './constants.js';
import type { AdminContext, AdminRequest } from './types.js';

/** Options for the admin workflow registry. */
export interface AdminWorkflowRegistryOptions {
  readonly selector: AgentSelector;
}

/** Builds the deterministic coordination recipes for Admin AI requests. */
export class AdminWorkflowRegistry {
  readonly name = 'admin-workflow-registry';

  private readonly selector: AgentSelector;

  constructor(options: AdminWorkflowRegistryOptions) {
    this.selector = options.selector;
  }

  /** Supported workflow ids (drives the status surface). */
  ids(): readonly string[] {
    return [ADMIN_EXECUTIVE_WORKFLOW];
  }

  /** True when the workflow id is served by this registry. */
  has(workflowId: string): boolean {
    return this.ids().includes(workflowId);
  }

  /**
   * Builds the coordination request for a workflow. Calls with an unknown id
   * throw (fail closed).
   */
  build(request: AdminRequest, context: AdminContext, workflowId: string): CoordinationRequest {
    switch (workflowId) {
      case ADMIN_EXECUTIVE_WORKFLOW:
        return this.buildExecutiveReview(request, context);
      default:
        throw new Error(`Unknown admin workflow: ${workflowId}`);
    }
  }

  private buildExecutiveReview(request: AdminRequest, context: AdminContext): CoordinationRequest {
    const limits = {
      maxTasks: ADMIN_DEFAULT_LIMITS.maxTasks,
      maxConcurrentTasks: ADMIN_DEFAULT_LIMITS.maxConcurrentTasks,
      maxTasksPerAgent: ADMIN_DEFAULT_LIMITS.maxTasksPerAgent,
      globalTimeoutMs: request.limits?.globalTimeoutMs ?? ADMIN_DEFAULT_LIMITS.globalTimeoutMs,
      defaultTaskTimeoutMs: request.limits?.timeoutMs ?? ADMIN_DEFAULT_LIMITS.defaultTaskTimeoutMs,
      maxMessageBytes: ADMIN_DEFAULT_LIMITS.maxMessageBytes,
    };
    const tasks = this.buildReviewTasks(request, context, limits.defaultTaskTimeoutMs);
    void this.selector;
    return {
      correlationId: request.correlationId,
      parentExecutionId: request.requestId,
      requester: 'AG-001',
      objective:
        'Compile an executive review from analytics, platform health and fraud triage signals in parallel',
      contextReference: request.requestId,
      mode: CoordinationMode.Hybrid,
      limits,
      deadline: limits.globalTimeoutMs,
      failurePolicy: TaskFailurePolicy.BestEffort,
      conflictPolicy: ConflictPolicy.AllResults,
      aggregation: AggregationStrategy.Collect,
      cancellation: request.cancellation?.signal,
      tasks,
      metadata: {
        team: 'admin',
        workflowId: ADMIN_EXECUTIVE_WORKFLOW,
        adminRequestId: request.adminRequestId,
      },
    };
  }

  private buildReviewTasks(
    request: AdminRequest,
    context: AdminContext,
    taskTimeoutMs: number,
  ): readonly CoordinationTaskInput[] {
    const sharedInput = {
      input: request.input,
      context: {
        memory: context.memory.map(({ id, namespace, key, content }) => ({
          id,
          namespace,
          key,
          content,
        })),
        knowledge: context.knowledge.map(({ id, namespace, key, content }) => ({
          id,
          namespace,
          key,
          content,
        })),
        truncated: context.truncated,
      },
      // BR-ADM-1: agent-level re-enforcement of role scopes (never expanded).
      'admin.scopes': request.actor.adminScopes ?? [],
    };
    const retry = {
      maxRetries: 1,
      retryable: true,
      backoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 1600,
    };
    const analytics: CoordinationTaskInput = {
      taskId: ADMIN_WORKFLOW_TASK_IDS.analytics,
      agentId: ADMIN_AGENT_IDS.analytics,
      objective: 'Interpret the data question into measure definitions and chart guidance',
      input: {
        ...sharedInput,
        'admin.capability': ADMIN_CAPABILITY_IDS.analytics,
      },
      dependencies: [],
      requiredCapabilities: [ADMIN_CAPABILITY_IDS.analytics],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const health: CoordinationTaskInput = {
      taskId: ADMIN_WORKFLOW_TASK_IDS.health,
      agentId: ADMIN_AGENT_IDS.platformHealth,
      objective: 'Assess observed platform metrics, SLOs and service topology',
      input: {
        ...sharedInput,
        'admin.capability': ADMIN_CAPABILITY_IDS.health,
      },
      dependencies: [],
      requiredCapabilities: [ADMIN_CAPABILITY_IDS.health],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const fraud: CoordinationTaskInput = {
      taskId: ADMIN_WORKFLOW_TASK_IDS.fraud,
      agentId: ADMIN_AGENT_IDS.fraudMonitoring,
      objective: 'Triage supplied fraud signals with SLA deadlines; never auto-ban',
      input: {
        ...sharedInput,
        'admin.capability': ADMIN_CAPABILITY_IDS.fraud,
      },
      dependencies: [],
      requiredCapabilities: [ADMIN_CAPABILITY_IDS.fraud],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    return [analytics, health, fraud];
  }
}
