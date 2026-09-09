/**
 * Sprint 24 — Marketing AI Team v1. The Marketing AI Service.
 *
 * Deterministic-first execution surface for marketing requests:
 *
 *   1. validate input (injection-shape input is rejected),
 *   2. assemble bounded context through AG-002 memory + AG-003 knowledge,
 *   3. route through the Marketing Team Router (AG-001 intent authority),
 *   4. execute single agents through the platform executor OR run a
 *      coordination workflow (campaign content brief fan-out),
 *   5. execute authorized AG-004 tools and/or the optional agentic path,
 *   6. return the always-safe {@link MarketingResult} (never throws).
 *
 * Marketing insights are never fabricated: capabilities that can only derive
 * observations from provided brand copy or research sources report
 * `dataSufficient`/`draftComplete` honestly and the service counts those
 * reports into metrics and events. Drafts are never auto-published (AG-402/
 * AG-403/AG-405, BR-AI-2), promises are never inflated (BR-AI-5) and the
 * service never touches storage directly, never bypasses the platform
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
import {
  MARKETING_AGENT_IDS,
  MARKETING_DEFAULT_LIMITS,
  MARKETING_MAX_SOURCES,
} from './constants.js';
import type { MarketingContextBuilder } from './context.js';
import { MARKETING_AI_ERROR_CODES, MarketingAIError, toMarketingAIError } from './errors.js';
import { MarketingAIEventLog } from './events.js';
import { MarketingAIMetrics } from './metrics.js';
import type { MarketingTeamRouter } from './router.js';
import { assertInputPayloadSafe } from './security.js';
import { marketingToolActor, runMarketingAgenticTask } from './tooling.js';
import type { MarketingToolClient } from './tooling.js';
import type {
  MarketingContext,
  MarketingRecommendation,
  MarketingRequest,
  MarketingRequestStatus,
  MarketingResult,
  MarketingSection,
} from './types.js';
import type { MarketingWorkflowRegistry } from './workflows.js';

/** Options for the marketing-AI service. */
export interface MarketingAIServiceOptions {
  readonly router: MarketingTeamRouter;
  readonly workflows: MarketingWorkflowRegistry;
  readonly contextBuilder: MarketingContextBuilder;
  readonly coordination: CoordinationCoordinator;
  readonly executorRegistry: ExecutorRegistry;
  readonly gateway: AgentPlatformGateway;
  readonly toolClient?: MarketingToolClient;
  readonly agenticLoop?: AgenticLoopService;
  readonly eventLog?: MarketingAIEventLog;
  readonly metrics?: MarketingAIMetrics;
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

/** The Marketing AI service (deterministic-first, fail-closed). */
export class MarketingAIService {
  readonly name = 'marketing-ai-service';
  readonly version = '1.0.0';

  private readonly router: MarketingTeamRouter;
  private readonly workflows: MarketingWorkflowRegistry;
  private readonly contextBuilder: MarketingContextBuilder;
  private readonly coordination: CoordinationCoordinator;
  private readonly executorRegistry: ExecutorRegistry;
  private readonly gateway: AgentPlatformGateway;
  private readonly toolClient?: MarketingToolClient;
  private readonly agenticLoop?: AgenticLoopService;
  private readonly eventLog: MarketingAIEventLog;
  private readonly metrics: MarketingAIMetrics;
  private readonly logger?: Logger;

  private readonly allManagedAgents: readonly string[] = [
    MARKETING_AGENT_IDS.research,
    MARKETING_AGENT_IDS.socialMedia,
    MARKETING_AGENT_IDS.blogWriter,
    MARKETING_AGENT_IDS.seoSpecialist,
    MARKETING_AGENT_IDS.emailMarketer,
  ];

  constructor(options: MarketingAIServiceOptions) {
    this.router = options.router;
    this.workflows = options.workflows;
    this.contextBuilder = options.contextBuilder;
    this.coordination = options.coordination;
    this.executorRegistry = options.executorRegistry;
    this.gateway = options.gateway;
    this.toolClient = options.toolClient;
    this.agenticLoop = options.agenticLoop;
    this.eventLog = options.eventLog ?? new MarketingAIEventLog();
    this.metrics = options.metrics ?? new MarketingAIMetrics();
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
    readonly metrics: ReturnType<MarketingAIMetrics['snapshot']>;
    readonly eventCount: number;
  } {
    const active = this.allManagedAgents.filter((agentId) =>
      this.gateway.isPlatformManaged(agentId),
    ).length;
    const healthy = active === this.allManagedAgents.length && this.workflows.ids().length > 0;
    return {
      healthy,
      enabled: this.gateway.isPlatformManaged(MARKETING_AGENT_IDS.research),
      agents: { ids: this.allManagedAgents, active },
      workflows: this.workflows.ids(),
      metrics: this.metrics.snapshot(),
      eventCount: this.eventLog.count(),
    };
  }

  /**
   * Handles a validated marketing request and ALWAYS returns a
   * {@link MarketingResult} (never throws). Safe errors are embedded in the
   * result.
   */
  async handle(request: MarketingRequest): Promise<MarketingResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    this.metrics.recordStarted();
    this.logger?.info(
      { marketingRequestId: request.marketingRequestId },
      'marketing request started',
    );

    try {
      assertInputPayloadSafe(request.input);
    } catch (error) {
      return this.finalizeFailure(request, startedAt, startMs, error, 'PROMPT_INJECTION_REJECTED');
    }

    const context = await this.buildContext(request);
    this.emit('MARKETING_MEMORY_ACCESSED', request, {
      count: context.memory.length,
      taskId: 'context',
    });
    this.emit('MARKETING_KNOWLEDGE_ACCESSED', request, {
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
    this.emit('MARKETING_WORKFLOW_SELECTED', request, {
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
    request: MarketingRequest,
    context: MarketingContext,
    route: SingleRoute,
    startedAt: string,
    startMs: number,
  ): Promise<MarketingResult> {
    if (request.task?.mode === 'agentic') {
      return this.runAgentic(request, context, route, startedAt, startMs);
    }

    this.emit('MARKETING_AGENT_STARTED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'single',
    });
    this.metrics.recordAgentExecution();
    const executionId = `exec_marketing_${request.marketingRequestId}_${route.agentId}`;
    const policy = {
      timeoutMs: request.limits?.timeoutMs ?? MARKETING_DEFAULT_LIMITS.defaultTaskTimeoutMs,
      retry: { maxRetries: 0, retryable: true, backoffMs: 0 },
      failureBehavior: FailurePolicy.FailFast,
      continueOnFailure: false,
      stopOnFailure: true,
      fallbackAllowed: false,
      maxSteps: 1,
      maxTotalExecutionTimeMs:
        request.limits?.globalTimeoutMs ?? MARKETING_DEFAULT_LIMITS.globalTimeoutMs,
    };
    const outcome = await this.invokeExecutor(
      {
        executionId,
        stepId: `marketing:${route.agentId}:single`,
        agentId: route.agentId,
        inputs: this.sharedInputs(request, context, route.capabilityId),
        policy,
        traceId: request.traceId ?? `marketing:${request.correlationId}`,
      },
      request,
      route.agentId,
    );
    if (!outcome.success) {
      this.emit('MARKETING_AGENT_FAILED', request, {
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

    this.emit('MARKETING_AGENT_COMPLETED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'single',
    });
    const toolTrack = await this.runRequiredTools(request, route.agentId);
    const output = outcome.output as Record<string, unknown> | undefined;
    this.recordInsufficientDataIfNeeded(request, output, route.agentId);
    const recommendations = extractRecommendations([output]);
    if (recommendations.length > 0) {
      this.emit('MARKETING_RECOMMENDATION_GENERATED', request, {
        agentId: route.agentId,
        count: recommendations.length,
      });
    }
    const status: MarketingRequestStatus = 'COMPLETED';
    this.metrics.recordCompleted(Date.now() - startMs);
    return {
      marketingRequestId: request.marketingRequestId,
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
    request: MarketingRequest,
    context: MarketingContext,
    route: SingleRoute,
    startedAt: string,
    startMs: number,
  ): Promise<MarketingResult> {
    if (this.agenticLoop === undefined || this.toolClient === undefined) {
      this.metrics.recordAgenticRun(false);
      const error = {
        code: MARKETING_AI_ERROR_CODES.AGENT_REJECTED,
        message: 'Agentic mode was requested but the agentic stack is not configured',
      };
      return this.failedResult(request, startedAt, startMs, error, context, route.agentId);
    }
    this.emit('MARKETING_AGENT_STARTED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'agentic',
    });
    const namespace = request.actor.namespaces[0] ?? 'default';
    const outcome = await runMarketingAgenticTask({
      loop: this.agenticLoop,
      actor: marketingToolActor(route.agentId, request.actor),
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
        timeoutMs: request.limits?.timeoutMs ?? MARKETING_DEFAULT_LIMITS.defaultTaskTimeoutMs,
        signal: request.cancellation?.signal,
      },
    });
    if (outcome.status !== 'COMPLETED') {
      this.metrics.recordAgenticRun(false);
      this.emit('MARKETING_AGENT_FAILED', request, {
        agentId: route.agentId,
        reasonCode: outcome.errorCode ?? outcome.status,
      });
      const error = {
        code: outcome.errorCode ?? MARKETING_AI_ERROR_CODES.COORDINATION_FAILED,
        message: outcome.clarification ?? outcome.errorCode ?? 'Agentic run did not complete',
      };
      return this.failedResult(request, startedAt, startMs, error, context, route.agentId);
    }
    this.metrics.recordAgenticRun(true);
    this.emit('MARKETING_AGENT_COMPLETED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'agentic',
    });
    this.emit('MARKETING_TOOL_USED', request, {
      agentId: route.agentId,
      count: outcome.toolCallCount,
    });
    if (outcome.toolCallCount > 0) {
      this.metrics.recordToolCall(outcome.toolSuccessCount === outcome.toolCallCount);
    }
    this.metrics.recordCompleted(Date.now() - startMs);
    return {
      marketingRequestId: request.marketingRequestId,
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
    request: MarketingRequest,
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
        actor: marketingToolActor(agentId, request.actor),
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
      this.emit('MARKETING_TOOL_USED', request, {
        agentId,
        count: 1,
        reasonCode: outcome.errorCode,
      });
    }
    return { toolUsage, warnings };
  }

  private async invokeExecutor(
    request: AgentExecutionRequest,
    marketingRequest: MarketingRequest,
    agentId: string,
  ): Promise<ExecutionOutcome> {
    const executor = this.executorRegistry.resolve(agentId);
    if (executor === undefined || !executor.canExecute(agentId)) {
      throw new MarketingAIError(
        MARKETING_AI_ERROR_CODES.AGENT_REJECTED,
        `No executor can drive agent ${agentId}`,
      );
    }
    const startedMs = Date.now();
    const onAbort = () => {
      void executor.cancel(request.executionId);
    };
    const signal = marketingRequest.cancellation?.signal;
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
    request: MarketingRequest,
    context: MarketingContext,
    workflowId: string,
    startedAt: string,
    startMs: number,
  ): Promise<MarketingResult> {
    this.emit('MARKETING_WORKFLOW_STARTED', request, { workflowId, routeKind: 'workflow' });
    const coordinationRequest = this.workflows.build(request, context, workflowId);
    const coordinationResult = await this.coordination.coordinate(coordinationRequest);
    const status = this.mapCoordinationStatus(coordinationResult);
    if (status === 'FAILED') {
      this.metrics.recordCoordinationFailure();
      this.emit('MARKETING_WORKFLOW_FAILED', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
        status,
      });
    } else if (status === 'CANCELLED') {
      this.emit('MARKETING_WORKFLOW_CANCELLED', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
      });
      this.metrics.recordCancelled();
    } else if (status === 'TIMED_OUT') {
      this.emit('MARKETING_WORKFLOW_TIMEOUT', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
      });
      this.metrics.recordTimeout();
    }

    const sections = toSectionsFromCoordination(coordinationResult);
    const outputs = aggregationOutputs(coordinationResult);
    this.recordInsufficientDataIfNeeded(request, Object.fromEntries(outputs), 'marketing-campaign');
    const recommendations = extractRecommendations(
      Object.values(outputs).map((value) =>
        typeof value === 'object' && value !== null ? value : undefined,
      ),
    );
    if (recommendations.length > 0) {
      this.emit('MARKETING_RECOMMENDATION_GENERATED', request, {
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
      marketingRequestId: request.marketingRequestId,
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

  private async buildContext(request: MarketingRequest): Promise<MarketingContext> {
    const input = request.input;
    const sources = Array.isArray(input.research?.sources)
      ? (input.research.sources as readonly { source?: string; claim?: string }[])
      : [];
    const citedBrief =
      typeof input.blog?.topic === 'string' && input.blog.topic.trim().length > 0
        ? input.blog.topic
        : typeof input.research?.brief === 'string'
          ? input.research.brief
          : typeof input.email?.audience === 'string'
            ? input.email.audience
            : '';
    const keywords = [
      ...(Array.isArray(input.blog?.seoKeywords)
        ? (input.blog.seoKeywords as readonly string[])
        : []),
      ...(Array.isArray(input.social?.brandKeywords)
        ? (input.social.brandKeywords as readonly string[])
        : []),
      ...(Array.isArray(input.email?.brandKeywords)
        ? (input.email.brandKeywords as readonly string[])
        : []),
      ...(Array.isArray(input.seo?.keywords) ? (input.seo.keywords as readonly string[]) : []),
    ];
    const brief =
      citedBrief ||
      (sources[0]?.source ?? '') ||
      (sources[0]?.claim ?? '') ||
      (input.email?.subject ?? '');
    return this.contextBuilder.build({
      actor: request.actor,
      traceId: request.traceId,
      query: {
        brief: String(brief).slice(0, 4096),
        keywords: keywords.slice(0, MARKETING_MAX_SOURCES),
      },
      namespaces: request.actor.namespaces,
    });
  }

  private sharedInputs(
    request: MarketingRequest,
    context: MarketingContext,
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
      'marketing.capability': capabilityId,
      // Test/observability knob: deterministic latency for cancellation and
      // timeout scenarios (0..5000 ms). Never exposed to agent logic.
      ...(readKnobNumber(request.metadata, 'marketing.delayMs') !== undefined
        ? { 'marketing.delayMs': readKnobNumber(request.metadata, 'marketing.delayMs') }
        : {}),
    };
  }

  /** Counts & emits an insufficient-data report when the output says so. */
  private recordInsufficientDataIfNeeded(
    request: MarketingRequest,
    output: unknown,
    agentId: string,
  ): void {
    if (hasInsufficientDataSignal(output)) {
      this.metrics.recordInsufficientData();
      this.emit('MARKETING_INSUFFICIENT_DATA', request, {
        agentId,
        capabilityId: request.task?.capabilityId,
        count: 1,
      });
    }
  }

  private finalizeFromOutcome(
    request: MarketingRequest,
    startedAt: string,
    startMs: number,
    outcome: ExecutionOutcome,
    sections: readonly MarketingSection[],
    context: MarketingContext,
    agentId: string,
  ): MarketingResult {
    const code = outcome.error?.code ?? MARKETING_AI_ERROR_CODES.COORDINATION_FAILED;
    const timedOut =
      code === 'EXECUTION_TIMEOUT_ERROR' ||
      code === 'EXECUTION_TIMED_OUT' ||
      code === 'COORDINATION_TIMEOUT';
    const cancelled = code === 'EXECUTION_CANCELLED' || code === 'COORDINATION_CANCELLED';
    let status: MarketingRequestStatus = 'FAILED';
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
      message: outcome.error?.message ?? 'Marketing agent execution failed',
    };
    return {
      marketingRequestId: request.marketingRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: 'single',
      agents: [agentId],
      response: `The marketing request could not be completed (${code}).`,
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
    request: MarketingRequest,
    startedAt: string,
    startMs: number,
    error: unknown,
    _tag: string,
  ): MarketingResult {
    const mapped = error instanceof MarketingAIError ? error : toMarketingAIError(error);
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
    request: MarketingRequest,
    startedAt: string,
    startMs: number,
    error: { code: string; message: string },
    context: MarketingContext,
    agentId: string | undefined,
  ): MarketingResult {
    const timedOut = error.code === MARKETING_AI_ERROR_CODES.COORDINATION_TIMEOUT;
    const cancelled =
      error.code === MARKETING_AI_ERROR_CODES.CANCELLED || request.cancellation?.requested === true;
    const status: MarketingRequestStatus = timedOut
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
      marketingRequestId: request.marketingRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: undefined,
      agents: agentId === undefined ? [] : [agentId],
      response: `The marketing request could not be completed (${error.code}).`,
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
    status: MarketingRequestStatus,
    outputs: ReadonlyMap<string, unknown>,
  ): string {
    const parts: string[] = [];
    const research = (
      outputs.get('research') as
        { research?: { dataSufficient?: boolean; insights?: readonly unknown[] } } | undefined
    )?.research;
    if (research !== undefined) {
      parts.push(
        research.dataSufficient === false
          ? 'Research: no cited sources yielded insights.'
          : `Research: ${research.insights?.length ?? 0} cited insight${(research.insights?.length ?? 0) === 1 ? '' : 's'} compiled.`,
      );
    }
    const social = (outputs.get('social') as { social?: { draftComplete?: boolean } } | undefined)
      ?.social;
    if (social !== undefined) {
      parts.push(
        social.draftComplete === true
          ? 'Social: draft copy structure ready; publish gated behind review.'
          : 'Social: draft copy pending — provide post copy or approve the structure.',
      );
    }
    const email = (outputs.get('email') as { email?: { draftComplete?: boolean } } | undefined)
      ?.email;
    if (email !== undefined) {
      parts.push(
        email.draftComplete === true
          ? 'Email: draft validated; sends gated behind human approval.'
          : 'Email: draft pending — subject, body and CTA are required.',
      );
    }
    if (parts.length === 0) {
      return status === 'COMPLETED'
        ? 'Campaign content brief generated.'
        : `Campaign content brief completed with a partial result (${status}).`;
    }
    return sanitizeResponse(`Campaign content brief: ${parts.join(' ')}`);
  }

  private mapCoordinationStatus(result: CoordinationResult): MarketingRequestStatus {
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
    type: Parameters<MarketingAIEventLog['append']>[0]['type'],
    request: MarketingRequest,
    metadata: Record<string, unknown> = {},
  ): void {
    this.eventLog.append({
      type,
      occurredAt: new Date().toISOString(),
      success: type.endsWith('FAILED') ? false : undefined,
      metadata: {
        marketingRequestId: request.marketingRequestId,
        correlationId: request.correlationId,
        traceId: request.traceId,
        requestId: request.requestId,
        ...metadata,
      },
    });
  }
}

const EMPTY_CONTEXT: MarketingContext = {
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

function toSectionsFromCoordination(result: CoordinationResult): readonly MarketingSection[] {
  return result.tasks.map((task: TaskResult): MarketingSection => {
    const status: MarketingSection['status'] =
      task.status === TaskStatus.Completed
        ? 'success'
        : task.status === TaskStatus.Skipped
          ? 'skipped'
          : 'failure';
    return {
      taskId: task.taskId,
      agentId: task.agentId,
      capability: 'marketing.task',
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
): readonly MarketingSection[] {
  return entries.map((entry) => ({
    agentId: entry.agentId,
    capability: 'marketing.task',
    status: 'success' as const,
    output:
      entry.output !== undefined && typeof entry.output === 'object'
        ? (entry.output as Record<string, unknown>)
        : undefined,
  }));
}

function extractRecommendations(
  outputs: readonly (Record<string, unknown> | undefined)[],
): readonly MarketingRecommendation[] {
  const out: MarketingRecommendation[] = [];
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

function agenticUserInput(request: MarketingRequest): string {
  const input = request.input;
  return (
    (typeof input.blog?.topic === 'string' && input.blog.topic.trim().length > 0
      ? input.blog.topic
      : typeof input.research?.brief === 'string'
        ? input.research.brief
        : typeof input.email?.audience === 'string'
          ? input.email.audience
          : '') || 'Review my marketing content request'
  );
}

function describeOutput(agentId: string, output: Record<string, unknown>): string {
  const research = output['research'] as
    | {
        dataSufficient?: boolean;
        insights?: readonly { claim?: string }[];
        rejectedInsightCount?: number;
        uncitedInsightsRejected?: boolean;
      }
    | undefined;
  if (research !== undefined) {
    if (research.dataSufficient === false) {
      return 'Research: no cited source yielded an insight — nothing is stated without a citation (BR-AI-4).';
    }
    return `Research: ${research.insights?.length ?? 0} cited insight${(research.insights?.length ?? 0) === 1 ? '' : 's'} compiled (${research.rejectedInsightCount ?? 0} uncited source${(research.rejectedInsightCount ?? 0) === 1 ? '' : 's'} rejected). Editors review before any KB write.`;
  }

  const social = output['social'] as
    | {
        dataSufficient?: boolean;
        draftComplete?: boolean;
        variants?: readonly { platform?: string; truncated?: boolean }[];
        engagementClaims?: readonly unknown[];
        publishable?: boolean;
      }
    | undefined;
  if (social !== undefined) {
    const variantCount = social.variants?.length ?? 0;
    if (social.draftComplete === true) {
      return `Social draft ready (${variantCount} platform variant${variantCount === 1 ? '' : 's'}). Publish is gated behind human review — no engagement claims are made.`;
    }
    return `Social draft pending — provide post copy or approve the structure for ${variantCount} platform variant${variantCount === 1 ? '' : 's'}. Nothing is fabricated.`;
  }

  const blog = output['blog'] as
    | {
        dataSufficient?: boolean;
        draftComplete?: boolean;
        topic?: string;
        inflatedPromisesDetected?: readonly string[];
        publishable?: boolean;
      }
    | undefined;
  if (blog !== undefined) {
    if (blog.dataSufficient === false) {
      return 'Blog draft pending — a topic is required to structure an SEO-ready draft.';
    }
    if (blog.draftComplete === true) {
      return `Blog draft structure ready for "${blog.topic}" (${blog.inflatedPromisesDetected?.length ?? 0} overclaim phrase${(blog.inflatedPromisesDetected?.length ?? 0) === 1 ? '' : 's'} flagged). Publish is gated behind human review.`;
    }
    return `Blog structure prepared for "${blog.topic}" — supply draft copy to complete it.`;
  }

  const seo = output['seo'] as
    | {
        dataSufficient?: boolean;
        findings?: readonly { code?: string; severity?: string }[];
        stuffingRiskKeywords?: readonly string[];
        rankingGuaranteed?: boolean;
        recommendations?: readonly string[];
      }
    | undefined;
  if (seo !== undefined) {
    if (seo.dataSufficient === false) {
      return 'SEO review pending — provide page content (title, meta, headings) and a keyword set.';
    }
    const stuffing =
      seo.stuffingRiskKeywords !== undefined && seo.stuffingRiskKeywords.length > 0
        ? ` ${String(seo.stuffingRiskKeywords[0])} is over-represented (no stuffing, BR-AI-5).`
        : '';
    return `On-page SEO review returned ${seo.findings?.length ?? 0} finding${(seo.findings?.length ?? 0) === 1 ? '' : 's'}. Ranking is never guaranteed.${stuffing}`;
  }

  const email = output['email'] as
    | {
        dataSufficient?: boolean;
        draftComplete?: boolean;
        spamRisks?: readonly string[];
        optOutRespected?: boolean;
        sendsGated?: boolean;
        publishable?: boolean;
      }
    | undefined;
  if (email !== undefined) {
    if (email.draftComplete === true) {
      const risks =
        email.spamRisks !== undefined && email.spamRisks.length > 0
          ? ` Risk signals: ${email.spamRisks.join(', ')}.`
          : '';
      return `Email draft validated (subject/body/CTA). Opt-outs honoured; sends gated behind human approval.${risks}`;
    }
    return 'Email draft pending — subject, body and CTA are required to validate a draft.';
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
