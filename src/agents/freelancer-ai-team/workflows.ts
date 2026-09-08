/**
 * Sprint 22 — Freelancer AI Team v1. Freelancer workflow recipes.
 *
 * Deterministic coordination recipes reused by the freelancer service. The only
 * coordination workflow this sprint ships is the proposal-draft pipeline
 * (task chain: AG-202 profile → AG-206 match → AG-201 proposal — catalog §11
 * AG-201 dependencies). All task inputs are derived from the validated request
 * + built context; the coordinator, planner and selector still vet every task
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
  FREELANCER_AGENT_IDS,
  FREELANCER_CAPABILITY_IDS,
  FREELANCER_DEFAULT_LIMITS,
  FREELANCER_PROPOSAL_WORKFLOW,
  FREELANCER_WORKFLOW_TASK_IDS,
} from './constants.js';
import type { FreelancerContext, FreelancerRequest } from './types.js';

/** Options for the freelancer workflow registry. */
export interface FreelancerWorkflowRegistryOptions {
  readonly selector: AgentSelector;
}

/** Builds the deterministic coordination recipes for Freelancer AI requests. */
export class FreelancerWorkflowRegistry {
  readonly name = 'freelancer-workflow-registry';

  private readonly selector: AgentSelector;

  constructor(options: FreelancerWorkflowRegistryOptions) {
    this.selector = options.selector;
  }

  /** Supported workflow ids (drives the status surface). */
  ids(): readonly string[] {
    return [FREELANCER_PROPOSAL_WORKFLOW];
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
    request: FreelancerRequest,
    context: FreelancerContext,
    workflowId: string,
  ): CoordinationRequest {
    switch (workflowId) {
      case FREELANCER_PROPOSAL_WORKFLOW:
        return this.buildProposalDraft(request, context);
      default:
        throw new Error(`Unknown freelancer workflow: ${workflowId}`);
    }
  }

  private buildProposalDraft(
    request: FreelancerRequest,
    context: FreelancerContext,
  ): CoordinationRequest {
    const limits = {
      maxTasks: FREELANCER_DEFAULT_LIMITS.maxTasks,
      maxConcurrentTasks: FREELANCER_DEFAULT_LIMITS.maxConcurrentTasks,
      maxTasksPerAgent: FREELANCER_DEFAULT_LIMITS.maxTasksPerAgent,
      globalTimeoutMs: request.limits?.globalTimeoutMs ?? FREELANCER_DEFAULT_LIMITS.globalTimeoutMs,
      defaultTaskTimeoutMs:
        request.limits?.timeoutMs ?? FREELANCER_DEFAULT_LIMITS.defaultTaskTimeoutMs,
      maxMessageBytes: FREELANCER_DEFAULT_LIMITS.maxMessageBytes,
    };
    const tasks = this.buildProposalDraftTasks(request, context, limits.defaultTaskTimeoutMs);
    void this.selector;
    return {
      correlationId: request.correlationId,
      parentExecutionId: request.requestId,
      requester: 'AG-001',
      objective: 'Draft a personalised, brief-aligned proposal for a freelancer',
      contextReference: request.requestId,
      mode: CoordinationMode.Pipeline,
      limits,
      deadline: limits.globalTimeoutMs,
      failurePolicy: TaskFailurePolicy.BestEffort,
      conflictPolicy: ConflictPolicy.AllResults,
      aggregation: AggregationStrategy.Collect,
      cancellation: request.cancellation?.signal,
      tasks,
      metadata: {
        team: 'freelancer',
        workflowId: FREELANCER_PROPOSAL_WORKFLOW,
        freelancerRequestId: request.freelancerRequestId,
      },
    };
  }

  private buildProposalDraftTasks(
    request: FreelancerRequest,
    context: FreelancerContext,
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
    const profile: CoordinationTaskInput = {
      taskId: FREELANCER_WORKFLOW_TASK_IDS.profile,
      agentId: FREELANCER_AGENT_IDS.profileOptimizer,
      objective: 'Analyze the freelancer profile for an informed proposal',
      input: sharedInput,
      dependencies: [],
      requiredCapabilities: [FREELANCER_CAPABILITY_IDS.profileAnalyze],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const match: CoordinationTaskInput = {
      taskId: FREELANCER_WORKFLOW_TASK_IDS.match,
      agentId: FREELANCER_AGENT_IDS.projectRecommendation,
      objective: 'Score the freelancer against the project for match context',
      input: sharedInput,
      dependencies: [FREELANCER_WORKFLOW_TASK_IDS.profile],
      requiredCapabilities: [FREELANCER_CAPABILITY_IDS.projectMatch],
      requiredTools: [],
      priority: 2,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const proposal: CoordinationTaskInput = {
      taskId: FREELANCER_WORKFLOW_TASK_IDS.proposal,
      agentId: FREELANCER_AGENT_IDS.proposalWriter,
      objective: 'Produce a brief-aligned proposal outline and alignment analysis',
      input: sharedInput,
      dependencies: [FREELANCER_WORKFLOW_TASK_IDS.match],
      requiredCapabilities: [FREELANCER_CAPABILITY_IDS.proposalDraft],
      requiredTools: [],
      priority: 3,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    return [profile, match, proposal];
  }
}
