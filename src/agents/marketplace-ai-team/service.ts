/**
 * Sprint 23 — Marketplace AI Team v1. The Marketplace AI Service.
 *
 * Deterministic-first execution surface for marketplace requests:
 *
 *   1. validate + sanitize input (injection-shape input is rejected),
 *   2. assemble bounded context through AG-002 memory + AG-003 knowledge,
 *   3. route through the Marketplace Team Router (AG-001 intent authority),
 *   4. execute single agents through the platform executor OR run a
 *      coordination workflow (engagement scope fan-out),
 *   5. execute authorized AG-004 tools and/or the optional agentic path,
 *   6. return the always-safe {@link MarketplaceResult} (never throws).
 *
 * Marketplace facts are never fabricated: capabilities that derive
 * observations from provided data report `insufficientData` honestly and the
 * service counts those reports into metrics and events (Sprint 23 §28).
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
import { MARKETPLACE_AGENT_IDS, MARKETPLACE_DEFAULT_LIMITS } from './constants.js';
import type { MarketplaceContextBuilder } from './context.js';
import { MarketplaceAIError, MARKETPLACE_AI_ERROR_CODES, toMarketplaceAIError } from './errors.js';
import { MarketplaceAIEventLog } from './events.js';
import { MarketplaceAIMetrics } from './metrics.js';
import type { MarketplaceTeamRouter } from './router.js';
import { assertInputPayloadSafe } from './security.js';
import { marketplaceToolActor, runMarketplaceAgenticTask } from './tooling.js';
import type { MarketplaceToolClient } from './tooling.js';
import type {
  MarketplaceContext,
  MarketplaceRecommendation,
  MarketplaceRequest,
  MarketplaceRequestStatus,
  MarketplaceResult,
  MarketplaceSection,
} from './types.js';
import type { MarketplaceWorkflowRegistry } from './workflows.js';

/** Options for the marketplace-AI service. */
export interface MarketplaceAIServiceOptions {
  readonly router: MarketplaceTeamRouter;
  readonly workflows: MarketplaceWorkflowRegistry;
  readonly contextBuilder: MarketplaceContextBuilder;
  readonly coordination: CoordinationCoordinator;
  readonly executorRegistry: ExecutorRegistry;
  readonly gateway: AgentPlatformGateway;
  readonly toolClient?: MarketplaceToolClient;
  readonly agenticLoop?: AgenticLoopService;
  readonly eventLog?: MarketplaceAIEventLog;
  readonly metrics?: MarketplaceAIMetrics;
  readonly logger?: Logger;
}

interface ExecutionOutcome {
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: ExecutionError;
  readonly durationMs: number;
}

interface SingleRoute {
  readonly agentId: string;
  readonly capabilityId: string;
}

/** The Marketplace AI service (deterministic-first, fail-closed). */
export class MarketplaceAIService {
  readonly name = 'marketplace-ai-service';
  readonly version = '1.0.0';

  private readonly router: MarketplaceTeamRouter;
  private readonly workflows: MarketplaceWorkflowRegistry;
  private readonly contextBuilder: MarketplaceContextBuilder;
  private readonly coordination: CoordinationCoordinator;
  private readonly executorRegistry: ExecutorRegistry;
  private readonly gateway: AgentPlatformGateway;
  private readonly toolClient?: MarketplaceToolClient;
  private readonly agenticLoop?: AgenticLoopService;
  private readonly eventLog: MarketplaceAIEventLog;
  private readonly metrics: MarketplaceAIMetrics;
  private readonly logger?: Logger;

  private readonly allManagedAgents: readonly string[] = [
    MARKETPLACE_AGENT_IDS.contractGenerator,
    MARKETPLACE_AGENT_IDS.milestonePlanner,
    MARKETPLACE_AGENT_IDS.reviewGenerator,
    MARKETPLACE_AGENT_IDS.scamDetector,
    MARKETPLACE_AGENT_IDS.disputeAssistant,
    MARKETPLACE_AGENT_IDS.messagingAssistant,
  ];

  constructor(options: MarketplaceAIServiceOptions) {
    this.router = options.router;
    this.workflows = options.workflows;
    this.contextBuilder = options.contextBuilder;
    this.coordination = options.coordination;
    this.executorRegistry = options.executorRegistry;
    this.gateway = options.gateway;
    this.toolClient = options.toolClient;
    this.agenticLoop = options.agenticLoop;
    this.eventLog = options.eventLog ?? new MarketplaceAIEventLog();
    this.metrics = options.metrics ?? new MarketplaceAIMetrics();
    this.logger = options.logger;
    this.metrics.setWorld({
      workflowIds: this.workflows.ids().length,
      agentIds: this.allManagedAgents.length,
    });
  }

  /** Lights-out status for the HTTP surface (never leaks internals). */
  status(): {
    readonly healthy: boolean;
    readonly enabled: boolean;
    readonly agents: { readonly ids: readonly string[]; readonly active: number };
    readonly workflows: readonly string[];
    readonly metrics: ReturnType<MarketplaceAIMetrics['snapshot']>;
    readonly eventCount: number;
  } {
    const active = this.allManagedAgents.filter((agentId) =>
      this.gateway.isPlatformManaged(agentId),
    ).length;
    const healthy = active === this.allManagedAgents.length && this.workflows.ids().length > 0;
    return {
      healthy,
      enabled: this.gateway.isPlatformManaged(MARKETPLACE_AGENT_IDS.contractGenerator),
      agents: { ids: this.allManagedAgents, active },
      workflows: this.workflows.ids(),
      metrics: this.metrics.snapshot(),
      eventCount: this.eventLog.count(),
    };
  }

  /**
   * Handles a validated marketplace request and ALWAYS returns a
   * {@link MarketplaceResult} (never throws). Safe errors are embedded in the
   * result.
   */
  async handle(request: MarketplaceRequest): Promise<MarketplaceResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    this.metrics.recordStarted();
    this.logger?.info(
      { marketplaceRequestId: request.marketplaceRequestId },
      'marketplace request started',
    );

    try {
      assertInputPayloadSafe(request.input);
    } catch (error) {
      return this.finalizeFailure(request, startedAt, startMs, error, 'PROMPT_INJECTION_REJECTED');
    }

    const context = await this.buildContext(request);
    this.emit('MARKETPLACE_MEMORY_ACCESSED', request, {
      count: context.memory.length,
      taskId: 'context',
    });
    this.emit('MARKETPLACE_KNOWLEDGE_ACCESSED', request, {
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
    this.emit('MARKETPLACE_WORKFLOW_SELECTED', request, {
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
      const single: SingleRoute = { agentId: route.agentId, capabilityId: route.capabilityId };
      return await this.runSingle(request, context, single, startedAt, startMs);
    } catch (error) {
      return this.finalizeFailure(request, startedAt, startMs, error, 'EXECUTION_FAILED');
    }
  }

  // -------------------------------------------------------------------------
  // Internals — single agent path
  // -------------------------------------------------------------------------

  private async runSingle(
    request: MarketplaceRequest,
    context: MarketplaceContext,
    route: SingleRoute,
    startedAt: string,
    startMs: number,
  ): Promise<MarketplaceResult> {
    if (request.task?.mode === 'agentic') {
      return this.runAgentic(request, context, route, startedAt, startMs);
    }

    this.emit('MARKETPLACE_AGENT_STARTED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'single',
    });
    this.metrics.recordAgentExecution();
    const executionId = `exec_marketplace_${request.marketplaceRequestId}_${route.agentId}`;
    const policy = {
      timeoutMs: request.limits?.timeoutMs ?? MARKETPLACE_DEFAULT_LIMITS.defaultTaskTimeoutMs,
      retry: { maxRetries: 0, retryable: true, backoffMs: 0 },
      failureBehavior: FailurePolicy.FailFast,
      continueOnFailure: false,
      stopOnFailure: true,
      fallbackAllowed: false,
      maxSteps: 1,
      maxTotalExecutionTimeMs:
        request.limits?.globalTimeoutMs ?? MARKETPLACE_DEFAULT_LIMITS.globalTimeoutMs,
    };
    const outcome = await this.invokeExecutor(
      {
        executionId,
        stepId: `marketplace:${route.agentId}:single`,
        agentId: route.agentId,
        inputs: this.sharedInputs(request, context, route.capabilityId),
        policy,
        traceId: request.traceId ?? `marketplace:${request.correlationId}`,
      },
      request,
      route.agentId,
    );
    if (!outcome.success) {
      this.emit('MARKETPLACE_AGENT_FAILED', request, {
        agentId: route.agentId,
        capabilityId: route.capabilityId,
        taskId: 'single',
        reasonCode: outcome.error?.code,
      });
      this.metrics.recordAgentFailure();
      return this.finalizeFromOutcome(
        request,
        startedAt,
        startMs,
        outcome,
        [],
        context,
        route.agentId,
      );
    }

    this.emit('MARKETPLACE_AGENT_COMPLETED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'single',
    });
    const toolTrack = await this.runRequiredTools(request, route.agentId);
    const output = outcome.output as Record<string, unknown> | undefined;
    this.recordInsufficientDataIfNeeded(request, output, route.agentId);
    const recommendations = extractRecommendations([output]);
    if (recommendations.length > 0) {
      this.emit('MARKETPLACE_RECOMMENDATION_GENERATED', request, {
        agentId: route.agentId,
        count: recommendations.length,
      });
    }
    const status: MarketplaceRequestStatus = 'COMPLETED';
    this.metrics.recordCompleted(Date.now() - startMs);
    return {
      marketplaceRequestId: request.marketplaceRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: 'single',
      agents: [route.agentId],
      response: this.describeSingle(route.agentId, output),
      structuredData: output === undefined ? undefined : sanitizeStructured(output),
      recommendations,
      confidence: recommendations[0]?.confidence,
      sections: toSections([{ agentId: route.agentId, output }]),
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
    request: MarketplaceRequest,
    context: MarketplaceContext,
    route: SingleRoute,
    startedAt: string,
    startMs: number,
  ): Promise<MarketplaceResult> {
    if (this.agenticLoop === undefined || this.toolClient === undefined) {
      this.metrics.recordAgenticRun(false);
      const error = {
        code: MARKETPLACE_AI_ERROR_CODES.AGENT_REJECTED,
        message: 'Agentic mode was requested but the agentic stack is not configured',
      };
      return this.failedResult(request, startedAt, startMs, error, context, route.agentId);
    }
    this.emit('MARKETPLACE_AGENT_STARTED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'agentic',
    });
    const namespace = request.actor.namespaces[0] ?? 'default';
    const outcome = await runMarketplaceAgenticTask({
      loop: this.agenticLoop,
      actor: marketplaceToolActor(route.agentId, request.actor),
      namespace,
      task: {
        agentId: route.agentId,
        capabilityId: route.capabilityId,
        userInput: agenticUserInput(request),
        context,
        allowedTools: request.task?.requiredTools,
        requestId: request.requestId,
        traceId: request.traceId,
        correlationId: request.correlationId,
        timeoutMs: request.limits?.timeoutMs ?? MARKETPLACE_DEFAULT_LIMITS.defaultTaskTimeoutMs,
        signal: request.cancellation?.signal,
      },
    });
    if (outcome.status !== 'COMPLETED') {
      this.metrics.recordAgenticRun(false);
      this.emit('MARKETPLACE_AGENT_FAILED', request, {
        agentId: route.agentId,
        reasonCode: outcome.errorCode ?? outcome.status,
      });
      const error = {
        code: outcome.errorCode ?? MARKETPLACE_AI_ERROR_CODES.COORDINATION_FAILED,
        message: outcome.clarification ?? outcome.errorCode ?? 'Agentic run did not complete',
      };
      return this.failedResult(request, startedAt, startMs, error, context, route.agentId);
    }
    this.metrics.recordAgenticRun(true);
    this.emit('MARKETPLACE_AGENT_COMPLETED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'agentic',
    });
    this.emit('MARKETPLACE_TOOL_USED', request, {
      agentId: route.agentId,
      count: outcome.toolCallCount,
    });
    if (outcome.toolCallCount > 0) {
      this.metrics.recordToolCall(outcome.toolSuccessCount === outcome.toolCallCount);
    }
    this.metrics.recordCompleted(Date.now() - startMs);
    return {
      marketplaceRequestId: request.marketplaceRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status: 'COMPLETED',
      intent: request.intent,
      routeKind: 'single',
      agents: [route.agentId],
      response: sanitizeResponse(outcome.finalResponse ?? ''),
      structuredData: {
        agentic: { status: outcome.status, toolCalls: outcome.toolCallCount, usage: outcome.usage },
      },
      confidence: undefined,
      sections: [{ agentId: route.agentId, capability: route.capabilityId, status: 'success' }],
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
    request: MarketplaceRequest,
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
        actor: marketplaceToolActor(agentId, request.actor),
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
      this.emit('MARKETPLACE_TOOL_USED', request, {
        agentId,
        count: 1,
        reasonCode: outcome.errorCode,
      });
    }
    return { toolUsage, warnings };
  }

  private async invokeExecutor(
    request: AgentExecutionRequest,
    marketplaceRequest: MarketplaceRequest,
    agentId: string,
  ): Promise<ExecutionOutcome> {
    const executor = this.executorRegistry.resolve(agentId);
    if (executor === undefined || !executor.canExecute(agentId)) {
      throw new MarketplaceAIError(
        MARKETPLACE_AI_ERROR_CODES.AGENT_REJECTED,
        `No executor can drive agent ${agentId}`,
      );
    }
    const startedMs = Date.now();
    const onAbort = () => {
      void executor.cancel(request.executionId);
    };
    const signal = marketplaceRequest.cancellation?.signal;
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
    request: MarketplaceRequest,
    context: MarketplaceContext,
    workflowId: string,
    startedAt: string,
    startMs: number,
  ): Promise<MarketplaceResult> {
    this.emit('MARKETPLACE_WORKFLOW_STARTED', request, { workflowId, routeKind: 'workflow' });
    const coordinationRequest = this.workflows.build(request, context, workflowId);
    const coordinationResult = await this.coordination.coordinate(coordinationRequest);
    const status = this.mapCoordinationStatus(coordinationResult);
    if (status === 'FAILED') {
      this.metrics.recordCoordinationFailure();
      this.emit('MARKETPLACE_WORKFLOW_FAILED', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
        status,
      });
    } else if (status === 'CANCELLED') {
      this.emit('MARKETPLACE_WORKFLOW_CANCELLED', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
      });
      this.metrics.recordCancelled();
    } else if (status === 'TIMED_OUT') {
      this.emit('MARKETPLACE_WORKFLOW_TIMEOUT', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
      });
      this.metrics.recordTimeout();
    }

    const sections = toSectionsFromCoordination(coordinationResult);
    const outputs = aggregationOutputs(coordinationResult);
    this.recordInsufficientDataIfNeeded(request, Object.fromEntries(outputs), 'engagement-scope');
    const recommendations = extractRecommendations(
      Object.values(outputs).map((value) =>
        typeof value === 'object' && value !== null ? value : undefined,
      ),
    );
    if (recommendations.length > 0) {
      this.emit('MARKETPLACE_RECOMMENDATION_GENERATED', request, {
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
      marketplaceRequestId: request.marketplaceRequestId,
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

  private async buildContext(request: MarketplaceRequest): Promise<MarketplaceContext> {
    const project = request.input.project;
    const freelancer = request.input.freelancer;
    const brief =
      (typeof project?.description === 'string' ? project.description : '') ||
      (typeof freelancer?.bio === 'string' ? freelancer.bio : '');
    const keywords =
      typeof freelancer?.skills === 'object' && Array.isArray(freelancer.skills)
        ? (freelancer.skills as readonly string[])
        : [];
    return this.contextBuilder.build({
      actor: request.actor,
      traceId: request.traceId,
      query: { brief, keywords },
      namespaces: request.actor.namespaces,
    });
  }

  private sharedInputs(
    request: MarketplaceRequest,
    context: MarketplaceContext,
    capabilityId: string,
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
      input: request.input,
      context: safeContext,
      'context.items': context.memory.length + context.knowledge.length,
      // Capability-aware dispatch: tells the runtime agent which analyzer to run.
      'marketplace.capability': capabilityId,
      // Test/observability knob: deterministic latency for cancellation and
      // timeout scenarios (0..5000 ms). Never exposed to agent logic.
      ...(readKnobNumber(request.metadata, 'marketplace.delayMs') !== undefined
        ? { 'marketplace.delayMs': readKnobNumber(request.metadata, 'marketplace.delayMs') }
        : {}),
    };
  }

  /** Counts & emits an insufficient-data report when the output says so (§28). */
  private recordInsufficientDataIfNeeded(
    request: MarketplaceRequest,
    output: unknown,
    agentId: string,
  ): void {
    if (hasInsufficientDataSignal(output)) {
      this.metrics.recordInsufficientData();
      this.emit('MARKETPLACE_INSUFFICIENT_DATA', request, {
        agentId,
        capabilityId: request.task?.capabilityId,
        count: 1,
      });
    }
  }

  private finalizeFromOutcome(
    request: MarketplaceRequest,
    startedAt: string,
    startMs: number,
    outcome: ExecutionOutcome,
    sections: readonly MarketplaceSection[],
    context: MarketplaceContext,
    agentId: string,
  ): MarketplaceResult {
    const code = outcome.error?.code ?? MARKETPLACE_AI_ERROR_CODES.COORDINATION_FAILED;
    const timedOut =
      code === 'EXECUTION_TIMEOUT_ERROR' ||
      code === 'EXECUTION_TIMED_OUT' ||
      code === 'COORDINATION_TIMEOUT';
    const cancelled = code === 'EXECUTION_CANCELLED' || code === 'COORDINATION_CANCELLED';
    let status: MarketplaceRequestStatus = 'FAILED';
    if (cancelled) {
      status = 'CANCELLED';
      this.metrics.recordCancelled();
    } else if (timedOut) {
      status = 'TIMED_OUT';
      this.metrics.recordTimeout();
    } else {
      this.metrics.recordFailed(Date.now() - startMs);
    }
    const error = {
      code,
      message: outcome.error?.message ?? 'Marketplace agent execution failed',
    };
    return {
      marketplaceRequestId: request.marketplaceRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: 'single',
      agents: [agentId],
      response: `The marketplace request could not be completed (${code}).`,
      sections:
        sections.length > 0
          ? sections
          : [
              {
                agentId,
                capability: request.task?.capabilityId ?? '',
                status: 'failure',
                error,
              },
            ],
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
    request: MarketplaceRequest,
    startedAt: string,
    startMs: number,
    error: unknown,
    _tag: string,
  ): MarketplaceResult {
    const mapped = error instanceof MarketplaceAIError ? error : toMarketplaceAIError(error);
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
    request: MarketplaceRequest,
    startedAt: string,
    startMs: number,
    error: { code: string; message: string },
    context: MarketplaceContext,
    agentId: string | undefined,
  ): MarketplaceResult {
    const timedOut = error.code === MARKETPLACE_AI_ERROR_CODES.COORDINATION_TIMEOUT;
    const cancelled =
      error.code === MARKETPLACE_AI_ERROR_CODES.CANCELLED ||
      request.cancellation?.requested === true;
    const status: MarketplaceRequestStatus = timedOut
      ? 'TIMED_OUT'
      : cancelled
        ? 'CANCELLED'
        : 'FAILED';
    if (timedOut) {
      this.metrics.recordTimeout();
    } else if (cancelled) {
      this.metrics.recordCancelled();
    }
    return {
      marketplaceRequestId: request.marketplaceRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: undefined,
      agents: agentId === undefined ? [] : [agentId],
      response: `The marketplace request could not be completed (${error.code}).`,
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
    return sanitizeResponse(describeOutput(agentId, output));
  }

  private describeWorkflow(
    status: MarketplaceRequestStatus,
    outputs: ReadonlyMap<string, unknown>,
  ): string {
    const parts: string[] = [];
    const risk = (outputs.get('risk') as { risk?: { score?: number; level?: string } } | undefined)
      ?.risk;
    if (risk?.score !== undefined) {
      parts.push(`Risk score ${risk.score}/100 (${risk.level ?? 'computed'}).`);
    }
    const milestones = (
      outputs.get('milestones') as
        | {
            milestones?: { milestoneSum?: number; budgetTotal?: number; escrowCompliant?: boolean };
          }
        | undefined
    )?.milestones;
    if (milestones?.budgetTotal !== undefined) {
      const compliant =
        milestones.escrowCompliant === true
          ? ' Escrow split is compliant.'
          : ' Escrow split needs adjustment.';
      parts.push(
        `Milestone plan totals ${milestones.milestoneSum ?? 0} against a budget of ${milestones.budgetTotal}.${compliant}`,
      );
    }
    const contract = (
      outputs.get('contract') as
        { contract?: { status?: string; sections?: readonly string[] } } | undefined
    )?.contract;
    if (contract?.status !== undefined) {
      const sectionCount = contract.sections?.length ?? 0;
      parts.push(
        contract.status === 'draft-outline'
          ? `Contract outline drafted with ${sectionCount} sections (outline only, never legal advice).`
          : `Contract outline ${contract.status} — review the missing terms before drafting.`,
      );
    }
    if (parts.length === 0) {
      return status === 'COMPLETED'
        ? 'Engagement scope generated with all requested sections.'
        : `Engagement scope completed with a partial result (${status}).`;
    }
    return sanitizeResponse(`Engagement scope: ${parts.join(' ')}`);
  }

  private mapCoordinationStatus(result: CoordinationResult): MarketplaceRequestStatus {
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
    type: Parameters<MarketplaceAIEventLog['append']>[0]['type'],
    request: MarketplaceRequest,
    metadata: Record<string, unknown> = {},
  ): void {
    this.eventLog.append({
      type,
      occurredAt: new Date().toISOString(),
      success: type.endsWith('FAILED') ? false : undefined,
      metadata: {
        marketplaceRequestId: request.marketplaceRequestId,
        correlationId: request.correlationId,
        traceId: request.traceId,
        requestId: request.requestId,
        ...metadata,
      },
    });
  }
}

const EMPTY_CONTEXT: MarketplaceContext = {
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

function toSectionsFromCoordination(result: CoordinationResult): readonly MarketplaceSection[] {
  return result.tasks.map((task: TaskResult): MarketplaceSection => {
    const status: MarketplaceSection['status'] =
      task.status === TaskStatus.Completed
        ? 'success'
        : task.status === TaskStatus.Skipped
          ? 'skipped'
          : 'failure';
    return {
      taskId: task.taskId,
      agentId: task.agentId,
      capability: 'marketplace.task',
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
): readonly MarketplaceSection[] {
  return entries.map((entry) => ({
    agentId: entry.agentId,
    capability: 'marketplace.task',
    status: 'success' as const,
    output:
      entry.output !== undefined && typeof entry.output === 'object'
        ? (entry.output as Record<string, unknown>)
        : undefined,
  }));
}

function extractRecommendations(
  outputs: readonly (Record<string, unknown> | undefined)[],
): readonly MarketplaceRecommendation[] {
  const out: MarketplaceRecommendation[] = [];
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

function agenticUserInput(request: MarketplaceRequest): string {
  const project = request.input.project;
  const freelancer = request.input.freelancer;
  const description =
    (typeof project?.description === 'string' ? project.description : '') ||
    (typeof freelancer?.bio === 'string' ? freelancer.bio : '');
  return description.length > 0 ? description : 'Review my marketplace request';
}

function describeOutput(agentId: string, output: Record<string, unknown>): string {
  const contract = output['contract'] as
    | {
        status?: string;
        blocked?: boolean;
        blockers?: readonly string[];
        sections?: readonly string[];
      }
    | undefined;
  if (contract !== undefined) {
    if (contract.blocked === true) {
      const blocker =
        contract.blockers !== undefined && contract.blockers.length > 0
          ? ` ${String(contract.blockers[0])}`
          : '';
      return `Contract outline blocked.${blocker}`;
    }
    if (contract.status === 'draft-outline') {
      return `Contract outline drafted with ${contract.sections?.length ?? 0} sections. Outline only — never legal advice.`;
    }
    return 'Contract outline pending — insufficient agreement data was provided.';
  }

  const milestones = output['milestones'] as
    | {
        dataSufficient?: boolean;
        escrowCompliant?: boolean;
        milestoneSum?: number;
        budgetTotal?: number;
        proposedSplit?: boolean;
      }
    | undefined;
  if (milestones !== undefined) {
    if (milestones.dataSufficient === false) {
      return 'Milestone planning pending — a budget is required to propose an escrow split.';
    }
    const mode =
      milestones.proposedSplit === true
        ? 'proposed a 3-part escrow split that'
        : 'validated a milestone plan that';
    return `Milestone planning ${mode} sums to ${milestones.milestoneSum ?? 0} against a budget of ${milestones.budgetTotal ?? 0} (${milestones.escrowCompliant === true ? 'compliant' : 'needs adjustment'}).`;
  }

  const budget = output['budget'] as
    | {
        budgetProvided?: boolean;
        resolvedTotal?: number;
        marketRate?: string;
        structureValid?: boolean;
      }
    | undefined;
  if (budget !== undefined) {
    if (budget.budgetProvided === false) {
      return 'Budget analysis pending — no budget range was provided; no market rate is claimed.';
    }
    return `Budget analysis observed a total of ${budget.resolvedTotal ?? 0} (structure ${budget.structureValid === true ? 'valid' : 'needs review'}). No market-rate claim is made.`;
  }

  const review = output['review'] as
    | { dataSufficient?: boolean; suggestedRating?: number | null; retaliationFlag?: boolean }
    | undefined;
  if (review !== undefined) {
    if (review.dataSufficient === false) {
      return 'Review draft pending — no observed engagement facts are available; nothing is invented.';
    }
    const flag =
      review.retaliationFlag === true
        ? ' The interaction records contain review-coercion language; flagged for human moderation.'
        : '';
    return `Neutral review outline drafted with a suggested rating of ${review.suggestedRating ?? 'n/a'} (awaiting user confirmation).${flag}`;
  }

  const risk = output['risk'] as
    | { dataSufficient?: boolean; score?: number; level?: string; recommendation?: string }
    | undefined;
  if (risk !== undefined) {
    if (risk.dataSufficient === false) {
      return 'No risk signal was observed in the provided data; nothing is assumed.';
    }
    return `Risk score ${risk.score}/100 (${risk.level ?? 'low'}). No automatic action is taken — humans review.`;
  }

  const insights = output['insights'] as
    | { insufficientData?: boolean; projectCount?: number; observedMetrics?: readonly string[] }
    | undefined;
  if (insights !== undefined) {
    if (insights.insufficientData === true) {
      return `Insufficient data (${insights.projectCount ?? 0} project${(insights.projectCount ?? 0) === 1 ? '' : 's'} provided) — observations are not reported.`;
    }
    const metric =
      insights.observedMetrics !== undefined && insights.observedMetrics.length > 0
        ? ` ${String(insights.observedMetrics[0])}.`
        : '';
    return `Marketplace insights computed from the provided dataset.${metric}`;
  }

  const discovery = output['discovery'] as
    | { dataSufficient?: boolean; discovered?: readonly { title?: string; fitScore?: number }[] }
    | undefined;
  if (discovery !== undefined) {
    if (discovery.dataSufficient === false) {
      return 'Discovery pending — a freelancer profile and a project inventory are required. Nothing is fabricated.';
    }
    const top =
      discovery.discovered !== undefined && discovery.discovered.length > 0
        ? ` Top match: ${discovery.discovered[0]?.title ?? 'a project'} (${discovery.discovered[0]?.fitScore ?? 0}/100).`
        : '';
    return `Ranked ${discovery.discovered?.length ?? 0} project${(discovery.discovered?.length ?? 0) === 1 ? '' : 's'} from the provided inventory.${top}`;
  }

  const quality = output['quality'] as
    | {
        status?: string;
        findings?: readonly { code?: string }[];
        recommendations?: readonly string[];
      }
    | undefined;
  if (quality !== undefined) {
    const findingCount = quality.findings?.length ?? 0;
    if (quality.status === 'complete') {
      return `Project quality: complete with ${findingCount} finding${findingCount === 1 ? '' : 's'}.`;
    }
    return `Project quality status: ${String(quality.status ?? 'insufficient data')} with ${findingCount} finding${findingCount === 1 ? '' : 's'}.`;
  }

  const opportunity = output['opportunity'] as
    { dataSufficient?: boolean; recommendedNextAction?: string } | undefined;
  if (opportunity !== undefined) {
    if (opportunity.dataSufficient === false) {
      return 'Opportunity analysis pending — a freelancer profile and a project are both required.';
    }
    return `Opportunity analyzed. ${String(opportunity.recommendedNextAction ?? '')}`;
  }

  const dispute = output['dispute'] as
    { dataSufficient?: boolean; recommendation?: string } | undefined;
  if (dispute !== undefined) {
    if (dispute.dataSufficient === false) {
      return 'Dispute analysis pending — provide the dispute record to compile the case summary.';
    }
    return `Dispute case summary compiled. ${String(dispute.recommendation ?? '')} Humans decide — no judgment is issued.`;
  }

  const message = output['message'] as
    | { verdict?: string; riskSignals?: readonly string[]; supportSuggestions?: readonly string[] }
    | undefined;
  if (message !== undefined) {
    const signals =
      message.riskSignals !== undefined && message.riskSignals.length > 0
        ? ` Signals: ${message.riskSignals.join(', ')}.`
        : '';
    const suggestion =
      message.supportSuggestions !== undefined && message.supportSuggestions.length > 0
        ? ` ${String(message.supportSuggestions[0])}`
        : '';
    return `Message filtered (${String(message.verdict ?? 'hold')}).${signals}${suggestion}`;
  }

  void agentId;
  return JSON.stringify(sanitizeStructured(output));
}

/** Recursively detects honest insufficient-data / dataSufficient=false signals. */
function hasInsufficientDataSignal(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasInsufficientDataSignal);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record['insufficientData'] === true ||
    record['dataSufficient'] === false ||
    record['status'] === 'insufficient data'
  ) {
    return true;
  }
  return Object.values(record).some(hasInsufficientDataSignal);
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
