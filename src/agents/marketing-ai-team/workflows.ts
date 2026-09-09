/**
 * Sprint 24 — Marketing AI Team v1. Marketing workflow recipes.
 *
 * Deterministic coordination recipes reused by the marketing service. The one
 * coordination workflow this sprint ships is campaign planning: three
 * independent tasks are fanned out in PARALLEL — research (AG-401
 * marketing.research), social (AG-402 marketing.post.draft) and email
 * (AG-405 marketing.email.draft) — and collected into a single campaign
 * content brief. Every task carries the exact requested capability so the
 * capability-aware runtime agents dispatch to the right analyzer. The
 * coordinator, planner and selector still vet every task at plan time through
 * the Sprint 20 + Sprint 19 layers.
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
  MARKETING_AGENT_IDS,
  MARKETING_CAPABILITY_IDS,
  MARKETING_DEFAULT_LIMITS,
  MARKETING_CAMPAIGN_WORKFLOW,
  MARKETING_WORKFLOW_TASK_IDS,
} from './constants.js';
import type { MarketingContext, MarketingRequest } from './types.js';

/** Options for the marketing workflow registry. */
export interface MarketingWorkflowRegistryOptions {
  readonly selector: AgentSelector;
}

/** Builds the deterministic coordination recipes for Marketing AI requests. */
export class MarketingWorkflowRegistry {
  readonly name = 'marketing-workflow-registry';

  private readonly selector: AgentSelector;

  constructor(options: MarketingWorkflowRegistryOptions) {
    this.selector = options.selector;
  }

  /** Supported workflow ids (drives the status surface). */
  ids(): readonly string[] {
    return [MARKETING_CAMPAIGN_WORKFLOW];
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
    request: MarketingRequest,
    context: MarketingContext,
    workflowId: string,
  ): CoordinationRequest {
    switch (workflowId) {
      case MARKETING_CAMPAIGN_WORKFLOW:
        return this.buildCampaign(request, context);
      default:
        throw new Error(`Unknown marketing workflow: ${workflowId}`);
    }
  }

  private buildCampaign(request: MarketingRequest, context: MarketingContext): CoordinationRequest {
    const limits = {
      maxTasks: MARKETING_DEFAULT_LIMITS.maxTasks,
      maxConcurrentTasks: MARKETING_DEFAULT_LIMITS.maxConcurrentTasks,
      maxTasksPerAgent: MARKETING_DEFAULT_LIMITS.maxTasksPerAgent,
      globalTimeoutMs: request.limits?.globalTimeoutMs ?? MARKETING_DEFAULT_LIMITS.globalTimeoutMs,
      defaultTaskTimeoutMs:
        request.limits?.timeoutMs ?? MARKETING_DEFAULT_LIMITS.defaultTaskTimeoutMs,
      maxMessageBytes: MARKETING_DEFAULT_LIMITS.maxMessageBytes,
    };
    const tasks = this.buildCampaignTasks(request, context, limits.defaultTaskTimeoutMs);
    void this.selector;
    return {
      correlationId: request.correlationId,
      parentExecutionId: request.requestId,
      requester: 'AG-001',
      objective:
        'Draft a campaign content brief from research, social and email inputs in parallel',
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
        team: 'marketing',
        workflowId: MARKETING_CAMPAIGN_WORKFLOW,
        marketingRequestId: request.marketingRequestId,
      },
    };
  }

  private buildCampaignTasks(
    request: MarketingRequest,
    context: MarketingContext,
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
    const research: CoordinationTaskInput = {
      taskId: MARKETING_WORKFLOW_TASK_IDS.research,
      agentId: MARKETING_AGENT_IDS.research,
      objective: 'Compile sourced insight summaries from the research brief',
      input: {
        ...sharedInput,
        'marketing.capability': MARKETING_CAPABILITY_IDS.research,
      },
      dependencies: [],
      requiredCapabilities: [MARKETING_CAPABILITY_IDS.research],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const social: CoordinationTaskInput = {
      taskId: MARKETING_WORKFLOW_TASK_IDS.social,
      agentId: MARKETING_AGENT_IDS.socialMedia,
      objective: 'Structure a social draft variant for the campaign brief',
      input: {
        ...sharedInput,
        'marketing.capability': MARKETING_CAPABILITY_IDS.socialPost,
      },
      dependencies: [],
      requiredCapabilities: [MARKETING_CAPABILITY_IDS.socialPost],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const email: CoordinationTaskInput = {
      taskId: MARKETING_WORKFLOW_TASK_IDS.email,
      agentId: MARKETING_AGENT_IDS.emailMarketer,
      objective: 'Structure an email draft for the campaign brief',
      input: {
        ...sharedInput,
        'marketing.capability': MARKETING_CAPABILITY_IDS.emailDraft,
      },
      dependencies: [],
      requiredCapabilities: [MARKETING_CAPABILITY_IDS.emailDraft],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    return [research, social, email];
  }
}
