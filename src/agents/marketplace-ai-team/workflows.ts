/**
 * Sprint 23 — Marketplace AI Team v1. Marketplace workflow recipes.
 *
 * Deterministic coordination recipes reused by the marketplace service. The
 * one coordination workflow this sprint ships is engagement scoping: three
 * independent tasks are fanned out in PARALLEL — risk (AG-304 scam.report),
 * milestones (AG-302 milestone.plan) and contract (AG-301 contract.generate)
 * — and collected into a single engagement brief. Every task carries the
 * exact requested capability so the capability-aware runtime agents dispatch
 * to the right analyzer. The coordinator, planner and selector still vet every
 * task at plan time through the Sprint 20 + Sprint 19 layers.
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
  MARKETPLACE_AGENT_IDS,
  MARKETPLACE_CAPABILITY_IDS,
  MARKETPLACE_DEFAULT_LIMITS,
  MARKETPLACE_ENGAGEMENT_WORKFLOW,
  MARKETPLACE_WORKFLOW_TASK_IDS,
} from './constants.js';
import type { MarketplaceContext, MarketplaceRequest } from './types.js';

/** Options for the marketplace workflow registry. */
export interface MarketplaceWorkflowRegistryOptions {
  readonly selector: AgentSelector;
}

/** Builds the deterministic coordination recipes for Marketplace AI requests. */
export class MarketplaceWorkflowRegistry {
  readonly name = 'marketplace-workflow-registry';

  private readonly selector: AgentSelector;

  constructor(options: MarketplaceWorkflowRegistryOptions) {
    this.selector = options.selector;
  }

  /** Supported workflow ids (drives the status surface). */
  ids(): readonly string[] {
    return [MARKETPLACE_ENGAGEMENT_WORKFLOW];
  }

  /** True when the workflow id is served by this registry. */
  has(workflowId: string): boolean {
    return this.ids().includes(workflowId);
  }

  /**
   * Builds the coordination request for a workflow. Calls with an unknown id
   * throw (fail closed).
   */
  build(
    request: MarketplaceRequest,
    context: MarketplaceContext,
    workflowId: string,
  ): CoordinationRequest {
    switch (workflowId) {
      case MARKETPLACE_ENGAGEMENT_WORKFLOW:
        return this.buildEngagementScope(request, context);
      default:
        throw new Error(`Unknown marketplace workflow: ${workflowId}`);
    }
  }

  private buildEngagementScope(
    request: MarketplaceRequest,
    context: MarketplaceContext,
  ): CoordinationRequest {
    const limits = {
      maxTasks: MARKETPLACE_DEFAULT_LIMITS.maxTasks,
      maxConcurrentTasks: MARKETPLACE_DEFAULT_LIMITS.maxConcurrentTasks,
      maxTasksPerAgent: MARKETPLACE_DEFAULT_LIMITS.maxTasksPerAgent,
      globalTimeoutMs:
        request.limits?.globalTimeoutMs ?? MARKETPLACE_DEFAULT_LIMITS.globalTimeoutMs,
      defaultTaskTimeoutMs:
        request.limits?.timeoutMs ?? MARKETPLACE_DEFAULT_LIMITS.defaultTaskTimeoutMs,
      maxMessageBytes: MARKETPLACE_DEFAULT_LIMITS.maxMessageBytes,
    };
    const tasks = this.buildEngagementScopeTasks(request, context, limits.defaultTaskTimeoutMs);
    void this.selector;
    return {
      correlationId: request.correlationId,
      parentExecutionId: request.requestId,
      requester: 'AG-001',
      objective:
        'Draft a complete engagement scope from risk, milestone and contract inputs in parallel',
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
        team: 'marketplace',
        workflowId: MARKETPLACE_ENGAGEMENT_WORKFLOW,
        marketplaceRequestId: request.marketplaceRequestId,
      },
    };
  }

  private buildEngagementScopeTasks(
    request: MarketplaceRequest,
    context: MarketplaceContext,
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
    };
    const retry = {
      maxRetries: 1,
      retryable: true,
      backoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 1600,
    };
    const risk: CoordinationTaskInput = {
      taskId: MARKETPLACE_WORKFLOW_TASK_IDS.risk,
      agentId: MARKETPLACE_AGENT_IDS.scamDetector,
      objective: 'Assess risk signals for the engagement scope',
      input: {
        ...sharedInput,
        'marketplace.capability': MARKETPLACE_CAPABILITY_IDS.scamReport,
      },
      dependencies: [],
      requiredCapabilities: [MARKETPLACE_CAPABILITY_IDS.scamReport],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const milestones: CoordinationTaskInput = {
      taskId: MARKETPLACE_WORKFLOW_TASK_IDS.milestones,
      agentId: MARKETPLACE_AGENT_IDS.milestonePlanner,
      objective: 'Plan milestone/escrow splits within the engagement budget',
      input: {
        ...sharedInput,
        'marketplace.capability': MARKETPLACE_CAPABILITY_IDS.milestonePlan,
      },
      dependencies: [],
      requiredCapabilities: [MARKETPLACE_CAPABILITY_IDS.milestonePlan],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const contract: CoordinationTaskInput = {
      taskId: MARKETPLACE_WORKFLOW_TASK_IDS.contract,
      agentId: MARKETPLACE_AGENT_IDS.contractGenerator,
      objective: 'Draft a contract outline from agreed engagement terms',
      input: {
        ...sharedInput,
        'marketplace.capability': MARKETPLACE_CAPABILITY_IDS.contractGenerate,
      },
      dependencies: [],
      requiredCapabilities: [MARKETPLACE_CAPABILITY_IDS.contractGenerate],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    return [risk, milestones, contract];
  }
}
