/**
 * Sprint 21 — Client AI Team v1. Client workflow recipes (§11).
 *
 * Deterministic coordination recipes reused by the client service. The only
 * workflow this sprint ships is project creation (task chain: AG-101 describe
 * → AG-102 budget + AG-103 timeline + AG-104 skills in parallel). All task
 * inputs are derived from the validated request + built context; the
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
  CLIENT_AGENT_IDS,
  CLIENT_CAPABILITY_IDS,
  CLIENT_DEFAULT_LIMITS,
  CLIENT_PROJECT_CREATION_WORKFLOW,
  CLIENT_WORKFLOW_TASK_IDS,
} from './constants.js';
import type { ClientContext, ClientRequest } from './types.js';

/** Options for the client workflow registry. */
export interface ClientWorkflowRegistryOptions {
  readonly selector: AgentSelector;
}

/** Builds the deterministic coordination recipes for Client AI requests. */
export class ClientWorkflowRegistry {
  readonly name = 'client-workflow-registry';

  private readonly selector: AgentSelector;

  constructor(options: ClientWorkflowRegistryOptions) {
    this.selector = options.selector;
  }

  /** Supported workflow ids (drives the status surface). */
  ids(): readonly string[] {
    return [CLIENT_PROJECT_CREATION_WORKFLOW];
  }

  /** True when the workflow id is served by this registry. */
  has(workflowId: string): boolean {
    return this.ids().includes(workflowId);
  }

  /**
   * Builds the coordination request for a workflow. Calls with an unknown id
   * throw (fail closed).
   */
  build(request: ClientRequest, context: ClientContext, workflowId: string): CoordinationRequest {
    switch (workflowId) {
      case CLIENT_PROJECT_CREATION_WORKFLOW:
        return this.buildProjectCreation(request, context);
      default:
        throw new Error(`Unknown client workflow: ${workflowId}`);
    }
  }

  private buildProjectCreation(
    request: ClientRequest,
    context: ClientContext,
  ): CoordinationRequest {
    const limits = {
      maxTasks: CLIENT_DEFAULT_LIMITS.maxTasks,
      maxConcurrentTasks: CLIENT_DEFAULT_LIMITS.maxConcurrentTasks,
      maxTasksPerAgent: CLIENT_DEFAULT_LIMITS.maxTasksPerAgent,
      globalTimeoutMs: request.limits?.globalTimeoutMs ?? CLIENT_DEFAULT_LIMITS.globalTimeoutMs,
      defaultTaskTimeoutMs: request.limits?.timeoutMs ?? CLIENT_DEFAULT_LIMITS.defaultTaskTimeoutMs,
      maxMessageBytes: CLIENT_DEFAULT_LIMITS.maxMessageBytes,
    };
    const tasks = this.buildProjectCreationTasks(request, context, limits.defaultTaskTimeoutMs);
    void this.selector;
    return {
      correlationId: request.correlationId,
      parentExecutionId: request.requestId,
      requester: 'AG-001',
      objective: 'Create a structured project description with supporting estimates',
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
        team: 'client',
        workflowId: CLIENT_PROJECT_CREATION_WORKFLOW,
        clientRequestId: request.clientRequestId,
      },
    };
  }

  private buildProjectCreationTasks(
    request: ClientRequest,
    context: ClientContext,
    taskTimeoutMs: number,
  ): readonly CoordinationTaskInput[] {
    const brief = typeof request.input.brief === 'string' ? request.input.brief : '';
    const sharedInput = {
      'request.input': brief,
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
    const describe: CoordinationTaskInput = {
      taskId: CLIENT_WORKFLOW_TASK_IDS.describe,
      agentId: CLIENT_AGENT_IDS.projectDescription,
      objective: 'Structure the project brief into a clear description',
      input: sharedInput,
      dependencies: [],
      requiredCapabilities: [CLIENT_CAPABILITY_IDS.projectCreate],
      requiredTools: [],
      priority: 1,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const budget: CoordinationTaskInput = {
      taskId: CLIENT_WORKFLOW_TASK_IDS.budget,
      agentId: CLIENT_AGENT_IDS.budgetEstimator,
      objective: 'Estimate a realistic project budget range',
      input: sharedInput,
      dependencies: [CLIENT_WORKFLOW_TASK_IDS.describe],
      requiredCapabilities: [CLIENT_CAPABILITY_IDS.budgetEstimate],
      requiredTools: [],
      priority: 2,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const timeline: CoordinationTaskInput = {
      taskId: CLIENT_WORKFLOW_TASK_IDS.timeline,
      agentId: CLIENT_AGENT_IDS.timelineEstimator,
      objective: 'Estimate a realistic project timeline range',
      input: sharedInput,
      dependencies: [CLIENT_WORKFLOW_TASK_IDS.describe],
      requiredCapabilities: [CLIENT_CAPABILITY_IDS.timelineEstimate],
      requiredTools: [],
      priority: 2,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    const skills: CoordinationTaskInput = {
      taskId: CLIENT_WORKFLOW_TASK_IDS.skills,
      agentId: CLIENT_AGENT_IDS.skillsRecommendation,
      objective: 'Recommend client-scoped skills for the project',
      input: sharedInput,
      dependencies: [CLIENT_WORKFLOW_TASK_IDS.describe],
      requiredCapabilities: [CLIENT_CAPABILITY_IDS.skillsRecommend],
      requiredTools: [],
      priority: 2,
      timeoutMs: taskTimeoutMs,
      retry,
    };
    return [describe, budget, timeline, skills];
  }
}
