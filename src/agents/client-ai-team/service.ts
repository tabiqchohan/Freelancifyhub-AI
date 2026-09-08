/**
 * Sprint 21 — Client AI Team v1. The Client AI Service (§16).
 *
 * Deterministic-first execution surface for client requests:
 *
 *   1. validate + sanitize input (injection-shape input is rejected),
 *   2. assemble bounded context through AG-002 memory + AG-003 knowledge,
 *   3. route through the Client Team Router (AG-001 intent authority),
 *   4. execute single agents through the platform executor OR run a
 *      coordination workflow (project creation),
 *   5. execute authorized AG-004 tools and/or the optional agentic path,
 *   6. return the always-safe {@link ClientResult} (never throws).
 *
 * The service never touches storage directly, never bypasses the platform
 * gateway / authorization, and never exposes secrets or raw payloads.
 */

import type { Logger } from 'pino';

import type { ExecutionError } from '../ag-001-master-orchestrator/execution/index.js';
import type {
  AgentExecutionRequest,
  ExecutorRegistry,
} from '../ag-001-master-orchestrator/execution/index.js';
import { FailurePolicy } from '../ag-001-master-orchestrator/planning/types/index.js';
import type { AgentPlatformGateway } from '../agent-platform/gateway.js';
import type { CoordinationCoordinator } from '../agent-platform/coordination/index.js';
import { CoordinationStatus, TaskStatus } from '../agent-platform/coordination/index.js';
import type { CoordinationResult, TaskResult } from '../agent-platform/coordination/index.js';
import type { AgenticLoopService } from '../runtime/agentic/index.js';
import { CLIENT_AGENT_IDS, CLIENT_DEFAULT_LIMITS } from './constants.js';
import type { ClientContextBuilder } from './context.js';
import { ClientAIError, CLIENT_AI_ERROR_CODES, toClientAIError } from './errors.js';
import { ClientAIEventLog } from './events.js';
import { ClientAIMetrics } from './metrics.js';
import type { ClientTeamRouter } from './router.js';
import { assertInputPayloadSafe } from './security.js';
import { clientToolActor, runClientAgenticTask } from './tooling.js';
import type { ClientToolClient } from './tooling.js';
import type {
  ClientContext,
  ClientRecommendation,
  ClientRequest,
  ClientRequestStatus,
  ClientResult,
  ClientSection,
} from './types.js';
import type { ClientWorkflowRegistry } from './workflows.js';

/** Options for the client-AI service. */
export interface ClientAIServiceOptions {
  readonly router: ClientTeamRouter;
  readonly workflows: ClientWorkflowRegistry;
  readonly contextBuilder: ClientContextBuilder;
  readonly coordination: CoordinationCoordinator;
  readonly executorRegistry: ExecutorRegistry;
  readonly gateway: AgentPlatformGateway;
  readonly toolClient?: ClientToolClient;
  readonly agenticLoop?: AgenticLoopService;
  readonly eventLog?: ClientAIEventLog;
  readonly metrics?: ClientAIMetrics;
  readonly logger?: Logger;
}

interface ExecutionOutcome {
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: ExecutionError;
  readonly durationMs: number;
}

/** The Client AI service (deterministic-first, fail-closed). */
export class ClientAIService {
  readonly name = 'client-ai-service';
  readonly version = '1.0.0';

  private readonly router: ClientTeamRouter;
  private readonly workflows: ClientWorkflowRegistry;
  private readonly contextBuilder: ClientContextBuilder;
  private readonly coordination: CoordinationCoordinator;
  private readonly executorRegistry: ExecutorRegistry;
  private readonly gateway: AgentPlatformGateway;
  private readonly toolClient?: ClientToolClient;
  private readonly agenticLoop?: AgenticLoopService;
  private readonly eventLog: ClientAIEventLog;
  private readonly metrics: ClientAIMetrics;
  private readonly logger?: Logger;

  constructor(options: ClientAIServiceOptions) {
    this.router = options.router;
    this.workflows = options.workflows;
    this.contextBuilder = options.contextBuilder;
    this.coordination = options.coordination;
    this.executorRegistry = options.executorRegistry;
    this.gateway = options.gateway;
    this.toolClient = options.toolClient;
    this.agenticLoop = options.agenticLoop;
    this.eventLog = options.eventLog ?? new ClientAIEventLog();
    this.metrics = options.metrics ?? new ClientAIMetrics();
    this.logger = options.logger;
    this.metrics.setWorld({
      workflowIds: this.workflows.ids().length,
      agentIds: [
        CLIENT_AGENT_IDS.projectDescription,
        CLIENT_AGENT_IDS.budgetEstimator,
        CLIENT_AGENT_IDS.timelineEstimator,
        CLIENT_AGENT_IDS.skillsRecommendation,
        CLIENT_AGENT_IDS.projectSuccessScore,
      ].length,
    });
  }

  /** Lights-out status for the HTTP surface (never leaks internals). */
  status(): {
    readonly healthy: boolean;
    readonly enabled: boolean;
    readonly agents: { readonly ids: readonly string[]; readonly active: number };
    readonly workflows: readonly string[];
    readonly metrics: ReturnType<ClientAIMetrics['snapshot']>;
    readonly eventCount: number;
  } {
    const allManaged = [CLIENT_AGENT_IDS.projectDescription, ...this.workflowAgentIds()];
    const active = allManaged.filter((agentId) => this.gateway.isPlatformManaged(agentId)).length;
    const healthy = active === allManaged.length && this.workflows.ids().length > 0;
    return {
      healthy,
      enabled: this.gateway.isPlatformManaged(CLIENT_AGENT_IDS.projectDescription),
      agents: { ids: allManaged, active },
      workflows: this.workflows.ids(),
      metrics: this.metrics.snapshot(),
      eventCount: this.eventLog.count(),
    };
  }

  /**
   * Handles a validated client request and ALWAYS returns a {@link ClientResult}
   * (never throws). Safe errors are embedded in the result.
   */
  async handle(request: ClientRequest): Promise<ClientResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    this.metrics.recordStarted();
    this.logger?.info({ clientRequestId: request.clientRequestId }, 'client request started');

    try {
      assertInputPayloadSafe(request.input);
    } catch (error) {
      return this.finalizeFailure(request, startedAt, startMs, error, 'PROMPT_INJECTION_REJECTED');
    }

    const context = await this.buildContext(request);
    this.emit('CLIENT_MEMORY_ACCESSED', request, {
      count: context.memory.length,
      taskId: 'context',
    });
    this.emit('CLIENT_KNOWLEDGE_ACCESSED', request, {
      count: context.knowledge.length,
      taskId: 'context',
    });
    if (context.memory.length > 0) {
      this.metrics.recordMemoryRetrieval();
    }
    if (context.knowledge.length > 0) {
      this.metrics.recordKnowledgeRetrieval();
    }

    let route;
    try {
      route = this.router.route(request);
    } catch (error) {
      return this.finalizeFailure(request, startedAt, startMs, error, 'ROUTING_REJECTED');
    }
    this.emit('CLIENT_WORKFLOW_SELECTED', request, {
      routeKind: route.kind,
      intent: request.intent,
      workflowId: route.kind === 'workflow' ? route.workflowId : undefined,
      agentId: route.kind === 'single' ? route.agentId : undefined,
    });

    try {
      if (route.kind === 'workflow') {
        this.metrics.recordCoordination();
        const result = await this.runWorkflow(
          request,
          context,
          route.workflowId,
          startedAt,
          startMs,
        );
        return result;
      }
      return await this.runSingle(request, context, route.agentId, startedAt, startMs);
    } catch (error) {
      return this.finalizeFailure(request, startedAt, startMs, error, 'EXECUTION_FAILED');
    }
  }

  // -------------------------------------------------------------------------
  // Internals — single agent path
  // -------------------------------------------------------------------------

  private async runSingle(
    request: ClientRequest,
    context: ClientContext,
    agentId: string,
    startedAt: string,
    startMs: number,
  ): Promise<ClientResult> {
    if (request.task?.mode === 'agentic') {
      return this.runAgentic(request, context, agentId, startedAt, startMs);
    }

    this.emit('CLIENT_AGENT_STARTED', request, { agentId, taskId: 'single' });
    this.metrics.recordAgentExecution();
    const executionId = `exec_client_${request.clientRequestId}_${agentId}`;
    const policy = {
      timeoutMs: request.limits?.timeoutMs ?? CLIENT_DEFAULT_LIMITS.defaultTaskTimeoutMs,
      retry: { maxRetries: 0, retryable: true, backoffMs: 0 },
      failureBehavior: FailurePolicy.FailFast,
      continueOnFailure: false,
      stopOnFailure: true,
      fallbackAllowed: false,
      maxSteps: 1,
      maxTotalExecutionTimeMs:
        request.limits?.globalTimeoutMs ?? CLIENT_DEFAULT_LIMITS.globalTimeoutMs,
    };
    const outcome = await this.invokeExecutor(
      {
        executionId,
        stepId: `client:${agentId}:single`,
        agentId,
        inputs: this.sharedInputs(request, context),
        policy,
        traceId: request.traceId ?? `client:${request.correlationId}`,
      },
      request,
      agentId,
    );
    if (!outcome.success) {
      this.emit('CLIENT_AGENT_FAILED', request, {
        agentId,
        taskId: 'single',
        reasonCode: outcome.error?.code,
      });
      this.metrics.recordAgentFailure();
      return this.finalizeFromOutcome(request, startedAt, startMs, outcome, [], context, agentId);
    }

    this.emit('CLIENT_AGENT_COMPLETED', request, { agentId, taskId: 'single' });
    const toolTrack = await this.runRequiredTools(request, agentId);
    const output = outcome.output as Record<string, unknown> | undefined;
    const recommendations = extractRecommendations([output]);
    if (recommendations.length > 0) {
      this.emit('CLIENT_RECOMMENDATION_GENERATED', request, {
        agentId,
        count: recommendations.length,
      });
    }
    const status: ClientRequestStatus = 'COMPLETED';
    this.metrics.recordCompleted(Date.now() - startMs);
    return {
      clientRequestId: request.clientRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: 'single',
      agents: [agentId],
      response: this.describeSingle(agentId, output),
      structuredData: output === undefined ? undefined : sanitizeStructured(output),
      recommendations,
      confidence: recommendations[0]?.confidence,
      sections: toSections([{ agentId, output }]),
      memoryReferences: context.memory.map((item) => item.id),
      knowledgeReferences: context.knowledge.map((item) => item.id),
      context: {
        memoryItems: context.memory.length,
        knowledgeDocs: context.knowledge.length,
        truncated: context.truncated,
      },
      toolUsage: toolTrack.toolUsage,
      warnings: [...context.warnings, ...toolTrack.warnings],
      errors: [],
      timing: this.timing(startedAt, startMs),
    };
  }

  private async runAgentic(
    request: ClientRequest,
    context: ClientContext,
    agentId: string,
    startedAt: string,
    startMs: number,
  ): Promise<ClientResult> {
    if (this.agenticLoop === undefined || this.toolClient === undefined) {
      this.metrics.recordAgenticRun(false);
      const error = {
        code: CLIENT_AI_ERROR_CODES.AGENT_REJECTED,
        message: 'Agentic mode was requested but the agentic stack is not configured',
      };
      return this.failedResult(request, startedAt, startMs, error, context, agentId);
    }
    this.emit('CLIENT_AGENT_STARTED', request, { agentId, taskId: 'agentic' });
    const namespace = request.actor.namespaces[0] ?? 'default';
    const outcome = await runClientAgenticTask({
      loop: this.agenticLoop,
      actor: clientToolActor(agentId, request.actor),
      namespace,
      task: {
        agentId,
        capabilityId: request.task?.capabilityId ?? 'agentic.task',
        userInput: typeof request.input.brief === 'string' ? request.input.brief : '',
        context,
        allowedTools: request.task?.requiredTools,
        requestId: request.requestId,
        traceId: request.traceId,
        correlationId: request.correlationId,
        timeoutMs: request.limits?.timeoutMs ?? CLIENT_DEFAULT_LIMITS.defaultTaskTimeoutMs,
        signal: request.cancellation?.signal,
      },
    });
    if (outcome.status !== 'COMPLETED') {
      this.metrics.recordAgenticRun(false);
      this.emit('CLIENT_AGENT_FAILED', request, {
        agentId,
        reasonCode: outcome.errorCode ?? outcome.status,
      });
      const error = {
        code: outcome.errorCode ?? CLIENT_AI_ERROR_CODES.COORDINATION_FAILED,
        message: outcome.clarification ?? outcome.errorCode ?? 'Agentic run did not complete',
      };
      return this.failedResult(request, startedAt, startMs, error, context, agentId);
    }
    this.metrics.recordAgenticRun(true);
    this.emit('CLIENT_AGENT_COMPLETED', request, { agentId, taskId: 'agentic' });
    this.emit('CLIENT_TOOL_USED', request, { agentId, count: outcome.toolCallCount });
    if (outcome.toolCallCount > 0) {
      this.metrics.recordToolCall(outcome.toolSuccessCount === outcome.toolCallCount);
    }
    this.metrics.recordCompleted(Date.now() - startMs);
    return {
      clientRequestId: request.clientRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status: 'COMPLETED',
      intent: request.intent,
      routeKind: 'single',
      agents: [agentId],
      response: sanitizeResponse(outcome.finalResponse ?? ''),
      structuredData: {
        agentic: { status: outcome.status, toolCalls: outcome.toolCallCount, usage: outcome.usage },
      },
      confidence: undefined,
      sections: [
        { agentId, capability: request.task?.capabilityId ?? 'agentic.task', status: 'success' },
      ],
      memoryReferences: context.memory.map((item) => item.id),
      knowledgeReferences: context.knowledge.map((item) => item.id),
      context: {
        memoryItems: context.memory.length,
        knowledgeDocs: context.knowledge.length,
        truncated: context.truncated,
      },
      toolUsage: {
        calls: outcome.toolCallCount,
        successes: outcome.toolSuccessCount,
        failures: outcome.toolCallCount - outcome.toolSuccessCount,
      },
      warnings: [...context.warnings],
      errors: [],
      timing: this.timing(startedAt, startMs),
    };
  }

  private async runRequiredTools(
    request: ClientRequest,
    agentId: string,
  ): Promise<{
    toolUsage: { calls: number; successes: number; failures: number };
    warnings: string[];
  }> {
    const toolUsage = { calls: 0, successes: 0, failures: 0 };
    const warnings: string[] = [];
    const toolCalls = request.task?.toolCalls ?? [];
    if (this.toolClient === undefined) {
      if (toolCalls.length > 0) {
        warnings.push('Tool execution requested but no tool client is configured.');
      }
      return { toolUsage, warnings };
    }
    const namespace = request.actor.namespaces[0] ?? 'default';
    for (const call of toolCalls) {
      const outcome = await this.toolClient.execute({
        agentId,
        toolName: call.name,
        toolInput: call.input,
        actor: clientToolActor(agentId, request.actor),
        namespace,
        requestId: request.requestId,
        traceId: request.traceId,
        correlationId: request.correlationId,
        timeoutMs: 2000,
      });
      toolUsage.calls += 1;
      if (outcome.success) {
        toolUsage.successes += 1;
      } else {
        toolUsage.failures += 1;
        warnings.push(`Tool '${call.name}': ${outcome.errorCode ?? 'failure'}`);
      }
      this.metrics.recordToolCall(outcome.success);
      this.emit('CLIENT_TOOL_USED', request, { agentId, count: 1, reasonCode: outcome.errorCode });
    }
    return { toolUsage, warnings };
  }

  private async invokeExecutor(
    request: AgentExecutionRequest,
    clientRequest: ClientRequest,
    agentId: string,
  ): Promise<ExecutionOutcome> {
    const executor = this.executorRegistry.resolve(agentId);
    if (executor === undefined || !executor.canExecute(agentId)) {
      throw new ClientAIError(
        CLIENT_AI_ERROR_CODES.AGENT_REJECTED,
        `No executor can drive agent ${agentId}`,
      );
    }
    const startedMs = Date.now();
    const onAbort = () => {
      void executor.cancel(request.executionId);
    };
    const signal = clientRequest.cancellation?.signal;
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const result = await executor.execute(request);
      return {
        success: result.success,
        output: result.output,
        error: result.error,
        durationMs: Date.now() - startedMs,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // -------------------------------------------------------------------------
  // Internals — workflow path
  // -------------------------------------------------------------------------

  private async runWorkflow(
    request: ClientRequest,
    context: ClientContext,
    workflowId: string,
    startedAt: string,
    startMs: number,
  ): Promise<ClientResult> {
    this.emit('CLIENT_WORKFLOW_STARTED', request, { workflowId, routeKind: 'workflow' });
    const coordinationRequest = this.workflows.build(request, context, workflowId);
    const coordinationResult = await this.coordination.coordinate(coordinationRequest);
    const status = this.mapCoordinationStatus(coordinationResult);
    if (status === 'FAILED') {
      this.metrics.recordCoordinationFailure();
      this.emit('CLIENT_WORKFLOW_FAILED', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
        status,
      });
    } else if (status === 'CANCELLED') {
      this.emit('CLIENT_WORKFLOW_CANCELLED', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
      });
      this.metrics.recordCancelled();
    } else if (status === 'TIMED_OUT') {
      this.emit('CLIENT_WORKFLOW_TIMEOUT', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
      });
      this.metrics.recordTimeout();
    }

    const sections = toSectionsFromCoordination(coordinationResult);
    const outputs = aggregationOutputs(coordinationResult);
    const recommendations = extractRecommendations(
      Object.values(outputs).map((value) =>
        typeof value === 'object' && value !== null ? value : undefined,
      ),
    );
    if (recommendations.length > 0) {
      this.emit('CLIENT_RECOMMENDATION_GENERATED', request, {
        workflowId,
        count: recommendations.length,
      });
    }
    const warnings = [...context.warnings];
    const errors: { code: string; message: string }[] = [];
    for (const section of sections) {
      if (section.status === 'failure') {
        errors.push({
          code: section.error?.code ?? 'EXECUTION_FAILED',
          message: section.error?.message ?? 'task failed',
        });
      }
    }
    if (status === 'COMPLETED_PARTIAL') {
      this.metrics.recordPartial(Date.now() - startMs);
    } else if (status === 'COMPLETED') {
      this.metrics.recordCompleted(Date.now() - startMs);
    } else {
      this.metrics.recordFailed(Date.now() - startMs);
    }

    const agents = [...new Set(coordinationResult.plan.tasks.map((task) => task.agentId))];
    return {
      clientRequestId: request.clientRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: 'workflow',
      agents,
      response: this.describeWorkflow(status, outputs),
      structuredData:
        outputs.size > 0 ? sanitizeStructured(Object.fromEntries(outputs)) : undefined,
      recommendations,
      confidence: recommendations.some((item) => item.confidence !== undefined)
        ? Math.round(
            (recommendations.reduce((sum, item) => sum + (item.confidence ?? 0), 0) /
              Math.max(1, recommendations.length)) *
              100,
          ) / 100
        : undefined,
      sections,
      coordinationId: coordinationResult.coordinationId,
      coordinationStatus: status,
      memoryReferences: context.memory.map((item) => item.id),
      knowledgeReferences: context.knowledge.map((item) => item.id),
      context: {
        memoryItems: context.memory.length,
        knowledgeDocs: context.knowledge.length,
        truncated: context.truncated,
      },
      warnings,
      errors,
      timing: this.timing(startedAt, startMs),
    };
  }

  // -------------------------------------------------------------------------
  // Internals — helpers
  // -------------------------------------------------------------------------

  private async buildContext(request: ClientRequest): Promise<ClientContext> {
    const brief = typeof request.input.brief === 'string' ? request.input.brief : '';
    return this.contextBuilder.build({
      actor: request.actor,
      traceId: request.traceId,
      query: { brief, keywords: [] },
      namespaces: request.actor.namespaces,
    });
  }

  private sharedInputs(
    request: ClientRequest,
    context: ClientContext,
  ): Readonly<Record<string, unknown>> {
    const safeContext = {
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
    };
    return {
      'request.input': typeof request.input.brief === 'string' ? request.input.brief : '',
      input: request.input,
      context: safeContext,
      'context.items': context.memory.length + context.knowledge.length,
      // Test/observability knob: deterministic latency for cancellation and
      // timeout scenarios (0..5000 ms). Never exposed to agent logic.
      ...(readKnobNumber(request.metadata, 'client.delayMs') !== undefined
        ? { 'client.delayMs': readKnobNumber(request.metadata, 'client.delayMs') }
        : {}),
    };
  }

  private finalizeFromOutcome(
    request: ClientRequest,
    startedAt: string,
    startMs: number,
    outcome: ExecutionOutcome,
    sections: readonly ClientSection[],
    context: ClientContext,
    agentId: string,
  ): ClientResult {
    const code = outcome.error?.code ?? CLIENT_AI_ERROR_CODES.COORDINATION_FAILED;
    const timedOut =
      code === 'EXECUTION_TIMEOUT_ERROR' ||
      code === 'EXECUTION_TIMED_OUT' ||
      code === 'COORDINATION_TIMEOUT';
    const cancelled = code === 'EXECUTION_CANCELLED' || code === 'COORDINATION_CANCELLED';
    let status: ClientRequestStatus = 'FAILED';
    if (cancelled) {
      status = 'CANCELLED';
      this.metrics.recordCancelled();
    } else if (timedOut) {
      status = 'TIMED_OUT';
      this.metrics.recordTimeout();
    } else {
      this.metrics.recordFailed(Date.now() - startMs);
    }
    const error = { code, message: outcome.error?.message ?? 'Client agent execution failed' };
    return {
      clientRequestId: request.clientRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: 'single',
      agents: [agentId],
      response: `The client request could not be completed (${code}).`,
      sections:
        sections.length > 0
          ? sections
          : [{ agentId, capability: request.task?.capabilityId ?? '', status: 'failure', error }],
      memoryReferences: context.memory.map((item) => item.id),
      knowledgeReferences: context.knowledge.map((item) => item.id),
      context: {
        memoryItems: context.memory.length,
        knowledgeDocs: context.knowledge.length,
        truncated: context.truncated,
      },
      warnings: [...context.warnings],
      errors: [error],
      timing: this.timing(startedAt, startMs),
    };
  }

  private finalizeFailure(
    request: ClientRequest,
    startedAt: string,
    startMs: number,
    error: unknown,
    _tag: string,
  ): ClientResult {
    const mapped = error instanceof ClientAIError ? error : toClientAIError(error);
    this.metrics.recordFailed(Date.now() - startMs);
    void _tag;
    return this.failedResult(
      request,
      startedAt,
      startMs,
      { code: mapped.code, message: mapped.message },
      EMPTY_CONTEXT,
      undefined,
    );
  }

  private failedResult(
    request: ClientRequest,
    startedAt: string,
    startMs: number,
    error: { code: string; message: string },
    context: ClientContext,
    agentId: string | undefined,
  ): ClientResult {
    const timedOut = error.code === CLIENT_AI_ERROR_CODES.COORDINATION_TIMEOUT;
    const cancelled =
      error.code === CLIENT_AI_ERROR_CODES.CANCELLED || request.cancellation?.requested === true;
    const status: ClientRequestStatus = timedOut ? 'TIMED_OUT' : cancelled ? 'CANCELLED' : 'FAILED';
    if (timedOut) {
      this.metrics.recordTimeout();
    } else if (cancelled) {
      this.metrics.recordCancelled();
    }
    return {
      clientRequestId: request.clientRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: undefined,
      agents: agentId === undefined ? [] : [agentId],
      response: `The client request could not be completed (${error.code}).`,
      memoryReferences: context.memory.map((item) => item.id),
      knowledgeReferences: context.knowledge.map((item) => item.id),
      context: {
        memoryItems: context.memory.length,
        knowledgeDocs: context.knowledge.length,
        truncated: context.truncated,
      },
      warnings: [...context.warnings],
      errors: [error],
      timing: this.timing(startedAt, startMs),
    };
  }

  private describeSingle(agentId: string, output: Record<string, unknown> | undefined): string {
    if (output === undefined) {
      return 'No structured output was produced for this request.';
    }
    const text = describeOutput(agentId, output);
    return sanitizeResponse(text);
  }

  private describeWorkflow(
    status: ClientRequestStatus,
    outputs: ReadonlyMap<string, unknown>,
  ): string {
    const parts: string[] = [];
    const description = outputs.get('describe') as { project?: { summary?: unknown } } | undefined;
    if (description?.project?.summary !== undefined) {
      parts.push(`Project description: ${String(description.project.summary)}`);
    }
    const budget = (
      outputs.get('budget') as
        { budget?: { range?: { min?: number; max?: number }; source?: string } } | undefined
    )?.budget;
    if (budget?.range !== undefined) {
      parts.push(
        `Budget estimate: $${budget.range.min}–$${budget.range.max} USD (${budget.source ?? 'calculated'}).`,
      );
    }
    const timeline = (
      outputs.get('timeline') as
        | { timeline?: { range?: { weeksMin?: number; weeksMax?: number }; source?: string } }
        | undefined
    )?.timeline;
    if (timeline?.range !== undefined) {
      parts.push(
        `Timeline estimate: ${timeline.range.weeksMin}–${timeline.range.weeksMax} weeks (${timeline.source ?? 'calculated'}).`,
      );
    }
    const skills = (
      outputs.get('skills') as { skills?: { required?: readonly { label?: string }[] } } | undefined
    )?.skills;
    if (skills?.required !== undefined && skills.required.length > 0) {
      parts.push(
        `Skill recommendations: ${skills.required
          .map((s) => s.label ?? '')
          .filter(Boolean)
          .join(', ')}.`,
      );
    }
    if (parts.length === 0) {
      return status === 'COMPLETED'
        ? 'Project created with default estimates.'
        : `Project creation completed with a partial result (${status}).`;
    }
    return sanitizeResponse(parts.join(' '));
  }

  private mapCoordinationStatus(result: CoordinationResult): ClientRequestStatus {
    switch (result.status) {
      case CoordinationStatus.Completed:
        return 'COMPLETED';
      case CoordinationStatus.Partial:
        return 'COMPLETED_PARTIAL';
      case CoordinationStatus.Cancelled:
        return 'CANCELLED';
      case CoordinationStatus.TimedOut:
        return 'TIMED_OUT';
      case CoordinationStatus.Failed:
      default:
        return 'FAILED';
    }
  }

  private timing(
    startedAt: string,
    startMs: number,
  ): { startedAt: string; completedAt: string; durationMs: number } {
    return { startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - startMs };
  }

  private emit(
    type: Parameters<ClientAIEventLog['append']>[0]['type'],
    request: ClientRequest,
    metadata: Record<string, unknown> = {},
  ): void {
    this.eventLog.append({
      type,
      occurredAt: new Date().toISOString(),
      success: type.endsWith('FAILED') ? false : undefined,
      metadata: {
        clientRequestId: request.clientRequestId,
        correlationId: request.correlationId,
        traceId: request.traceId,
        requestId: request.requestId,
        ...metadata,
      },
    });
  }

  /** Agent ids that participate in client workflows (for the status surface). */
  private workflowAgentIds(): readonly string[] {
    return [
      CLIENT_AGENT_IDS.budgetEstimator,
      CLIENT_AGENT_IDS.timelineEstimator,
      CLIENT_AGENT_IDS.skillsRecommendation,
      CLIENT_AGENT_IDS.projectSuccessScore,
    ];
  }
}

const EMPTY_CONTEXT: ClientContext = {
  memory: [],
  knowledge: [],
  truncated: false,
  warnings: [],
};

function aggregationOutputs(result: CoordinationResult): ReadonlyMap<string, unknown> {
  if (result.aggregate?.output !== undefined && typeof result.aggregate.output === 'object') {
    return new Map(Object.entries(result.aggregate.output as Record<string, unknown>));
  }
  return new Map<string, unknown>();
}

function toSectionsFromCoordination(result: CoordinationResult): readonly ClientSection[] {
  return result.tasks.map((task: TaskResult): ClientSection => {
    const status: ClientSection['status'] =
      task.status === TaskStatus.Completed
        ? 'success'
        : task.status === TaskStatus.Skipped
          ? 'skipped'
          : 'failure';
    return {
      taskId: task.taskId,
      agentId: task.agentId,
      capability:
        task.output !== undefined && typeof task.output === 'object'
          ? 'client.task'
          : 'client.task',
      status,
      output:
        task.output !== undefined && typeof task.output === 'object'
          ? (task.output as Record<string, unknown>)
          : undefined,
      error:
        task.errors[0] !== undefined
          ? { code: task.errors[0].code, message: task.errors[0].message }
          : undefined,
    };
  });
}

function toSections(
  entries: readonly { agentId: string; output?: unknown }[],
): readonly ClientSection[] {
  return entries.map((entry) => ({
    agentId: entry.agentId,
    capability: 'client.task',
    status: 'success' as const,
    output:
      entry.output !== undefined && typeof entry.output === 'object'
        ? (entry.output as Record<string, unknown>)
        : undefined,
  }));
}

function extractRecommendations(
  outputs: readonly (Record<string, unknown> | undefined)[],
): readonly ClientRecommendation[] {
  const out: ClientRecommendation[] = [];
  for (const output of outputs) {
    const list = output?.['recommendations'];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item !== null && typeof item === 'object' && 'recommendation' in item) {
          const candidate = item as {
            agentId?: string;
            capability?: string;
            title?: string;
            recommendation: string;
            urgency?: 'low' | 'medium' | 'high';
            confidence?: number;
          };
          out.push({
            agentId: candidate.agentId ?? '',
            capability: candidate.capability ?? '',
            title: candidate.title ?? 'Recommendation',
            recommendation: String(candidate.recommendation),
            urgency: candidate.urgency,
            confidence: candidate.confidence,
          });
        }
      }
    }
  }
  return out;
}

function describeOutput(agentId: string, output: Record<string, unknown>): string {
  if (agentId === CLIENT_AGENT_IDS.budgetEstimator) {
    const budget = output['budget'] as
      { range?: { min?: number; max?: number }; source?: string } | undefined;
    if (budget?.range !== undefined) {
      return `Budget estimate: $${budget.range.min}–$${budget.range.max} USD (${budget.source ?? 'calculated'}). Everything is an estimate and never a marketplace quote.`;
    }
  }
  if (agentId === CLIENT_AGENT_IDS.timelineEstimator) {
    const timeline = output['timeline'] as
      { range?: { weeksMin?: number; weeksMax?: number }; source?: string } | undefined;
    if (timeline?.range !== undefined) {
      return `Timeline estimate: ${timeline.range.weeksMin}–${timeline.range.weeksMax} weeks (${timeline.source ?? 'calculated'}).`;
    }
  }
  if (agentId === CLIENT_AGENT_IDS.skillsRecommendation) {
    const skills = output['skills'] as { required?: readonly { label?: string }[] } | undefined;
    if (skills?.required !== undefined) {
      return skills.required.length > 0
        ? `Recommended skill focus: ${skills.required
            .map((s) => s.label ?? '')
            .filter(Boolean)
            .join(', ')}.`
        : 'No catalog skills matched the brief yet; enrich the description.';
    }
  }
  if (agentId === CLIENT_AGENT_IDS.projectSuccessScore) {
    const score = output['score'] as { score?: number; strength?: string } | undefined;
    if (score?.score !== undefined) {
      return `Project success score: ${score.score}/100 (${score.strength ?? 'computed'}). Advisory only — never blocks publishing.`;
    }
  }
  if (agentId === CLIENT_AGENT_IDS.projectDescription) {
    const project = output['project'] as { summary?: unknown } | undefined;
    if (project?.summary !== undefined) {
      return `Project description: ${String(project.summary)}`;
    }
  }
  return JSON.stringify(sanitizeStructured(output));
}

function sanitizeStructured(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || value === undefined || typeof value !== 'object') {
    return {};
  }
  if (Array.isArray(value)) {
    return { items: value };
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/secret|token|password|__proto__|constructor/i.test(key))
      .map(([key, child]) => [key, sanitizeNested(child)]),
  );
}

function sanitizeNested(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNested(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!/secret|token|password|__proto__|constructor/i.test(key)) {
        out[key] = sanitizeNested(child);
      }
    }
    return out;
  }
  return value;
}

function sanitizeResponse(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 4096);
}

/** Deterministic, bounded knob reader from uncontrolled request metadata. */
function readKnobNumber(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
