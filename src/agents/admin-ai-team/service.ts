/**
 * Sprint 25 — Admin AI Team v1. The Admin AI Service.
 *
 * Deterministic-first execution surface for privileged admin requests:
 *
 *   1. validate input (injection-shape input is rejected),
 *   2. assemble bounded context through AG-002 memory + AG-003 knowledge,
 *   3. route through the Admin Team Router (AG-001 intent authority),
 *   4. authorize the actor for the route's capability (BR-ADM-1),
 *   5. execute single agents through the platform executor OR run the
 *      executive-review coordination workflow (analytics/health/fraud
 *      fan-out),
 *   6. execute authorized AG-004 tools and/or the optional agentic path,
 *   7. return the always-safe {@link AdminResult} (never throws).
 *
 * Admin insights are never fabricated: F21 analytics never invents metrics,
 * fraud alerts only review supplied signals (never auto-bans, BR-ADM-2),
 * health only reports observed metrics, AI operations never executes a change
 * (BR-ADM-4), and executive reviews only summarize supplied aggregated KPI
 * facts. Every mutating recommendation is stamped approval-required and
 * counted (BR-ADM-2); audits use fixed safe labels and never leak payloads
 * (BR-ADM-3). The service never touches storage directly, never bypasses the
 * platform gateway / authorization, and never exposes secrets, PII or raw
 * payloads.
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
import { ADMIN_AGENT_IDS, ADMIN_CAPABILITY_IDS, ADMIN_DEFAULT_LIMITS } from './constants.js';
import type { AdminContextBuilder } from './context.js';
import { AdminAIError, ADMIN_AI_ERROR_CODES, toAdminAIError } from './errors.js';
import {
  authorizeAdminRequest,
  isAuthorizationError,
  stampRecommendationApproval,
} from './authorization.js';
import type { AdminRecommendation } from './types.js';
import { AdminAIEventLog } from './events.js';
import { AdminAIMetrics } from './metrics.js';
import type { AdminTeamRouter } from './router.js';
import { assertInputPayloadSafe } from './security.js';
import { adminToolActor, runAdminAgenticTask } from './tooling.js';
import type { AdminToolClient } from './tooling.js';
import type {
  AdminContext,
  AdminRequest,
  AdminRequestStatus,
  AdminResult,
  AdminSection,
} from './types.js';
import type { AdminWorkflowRegistry } from './workflows.js';

/** Options for the admin-AI service. */
export interface AdminAIServiceOptions {
  readonly router: AdminTeamRouter;
  readonly workflows: AdminWorkflowRegistry;
  readonly contextBuilder: AdminContextBuilder;
  readonly coordination: CoordinationCoordinator;
  readonly executorRegistry: ExecutorRegistry;
  readonly gateway: AgentPlatformGateway;
  readonly toolClient?: AdminToolClient;
  readonly agenticLoop?: AgenticLoopService;
  readonly eventLog?: AdminAIEventLog;
  readonly metrics?: AdminAIMetrics;
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

/** The Admin AI service (deterministic-first, fail-closed). */
export class AdminAIService {
  readonly name = 'admin-ai-service';
  readonly version = '1.0.0';

  private readonly router: AdminTeamRouter;
  private readonly workflows: AdminWorkflowRegistry;
  private readonly contextBuilder: AdminContextBuilder;
  private readonly coordination: CoordinationCoordinator;
  private readonly executorRegistry: ExecutorRegistry;
  private readonly gateway: AgentPlatformGateway;
  private readonly toolClient?: AdminToolClient;
  private readonly agenticLoop?: AgenticLoopService;
  private readonly eventLog: AdminAIEventLog;
  private readonly metrics: AdminAIMetrics;
  private readonly logger?: Logger;

  private readonly allManagedAgents: readonly string[] = [
    ADMIN_AGENT_IDS.analytics,
    ADMIN_AGENT_IDS.fraudMonitoring,
    ADMIN_AGENT_IDS.platformHealth,
    ADMIN_AGENT_IDS.aiOperations,
    ADMIN_AGENT_IDS.executive,
  ];

  constructor(options: AdminAIServiceOptions) {
    this.router = options.router;
    this.workflows = options.workflows;
    this.contextBuilder = options.contextBuilder;
    this.coordination = options.coordination;
    this.executorRegistry = options.executorRegistry;
    this.gateway = options.gateway;
    this.toolClient = options.toolClient;
    this.agenticLoop = options.agenticLoop;
    this.eventLog = options.eventLog ?? new AdminAIEventLog();
    this.metrics = options.metrics ?? new AdminAIMetrics();
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
    readonly metrics: ReturnType<AdminAIMetrics['snapshot']>;
    readonly eventCount: number;
  } {
    const active = this.allManagedAgents.filter((agentId) =>
      this.gateway.isPlatformManaged(agentId),
    ).length;
    const healthy = active === this.allManagedAgents.length && this.workflows.ids().length > 0;
    return {
      healthy,
      enabled: this.gateway.isPlatformManaged(ADMIN_AGENT_IDS.analytics),
      agents: { ids: this.allManagedAgents, active },
      workflows: this.workflows.ids(),
      metrics: this.metrics.snapshot(),
      eventCount: this.eventLog.count(),
    };
  }

  /**
   * Handles a validated admin request and ALWAYS returns an {@link AdminResult}
   * (never throws). Safe errors are embedded in the result.
   */
  async handle(request: AdminRequest): Promise<AdminResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    this.metrics.recordStarted();
    this.logger?.info({ adminRequestId: request.adminRequestId }, 'admin request started');

    try {
      assertInputPayloadSafe(request.input);
    } catch (error) {
      return this.finalizeFailure(request, startedAt, startMs, error, 'PROMPT_INJECTION_REJECTED');
    }

    const context = await this.buildContext(request);
    this.emit('ADMIN_MEMORY_ACCESSED', request, {
      count: context.memory.length,
      taskId: 'context',
    });
    this.emit('ADMIN_KNOWLEDGE_ACCESSED', request, {
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
    this.emit('ADMIN_WORKFLOW_SELECTED', request, {
      routeKind: route.kind,
      intent: request.intent,
      workflowId: route.kind === 'workflow' ? route.workflowId : undefined,
      agentId: route.kind === 'single' ? route.agentId : undefined,
    });

    const capabilityId =
      route.kind === 'single' ? route.capabilityId : ADMIN_CAPABILITY_IDS.executive;
    try {
      // BR-ADM-1: fail closed before any execution when scopes are missing.
      authorizeAdminRequest(request.actor, capabilityId);
    } catch (error) {
      this.metrics.recordAuthorizationDenial();
      const scopeDenied =
        error instanceof AdminAIError && isAuthorizationError(error)
          ? error.code === ADMIN_AI_ERROR_CODES.FORBIDDEN
          : false;
      this.emit(scopeDenied ? 'ADMIN_CAPABILITY_DENIED' : 'ADMIN_AUTHORIZATION_DENIED', request, {
        capabilityId,
        reasonCode: error instanceof AdminAIError ? error.code : ADMIN_AI_ERROR_CODES.UNAUTHORIZED,
      });
      return this.finalizeFailure(request, startedAt, startMs, error, 'AUTHORIZATION_REJECTED');
    }

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
    request: AdminRequest,
    context: AdminContext,
    route: SingleRoute,
    startedAt: string,
    startMs: number,
  ): Promise<AdminResult> {
    if (request.task?.mode === 'agentic') {
      return this.runAgentic(request, context, route, startedAt, startMs);
    }

    this.emit('ADMIN_AGENT_STARTED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'single',
    });
    this.metrics.recordAgentExecution();
    const executionId = `exec_admin_${request.adminRequestId}_${route.agentId}`;
    const policy = {
      timeoutMs: request.limits?.timeoutMs ?? ADMIN_DEFAULT_LIMITS.defaultTaskTimeoutMs,
      retry: { maxRetries: 0, retryable: true, backoffMs: 0 },
      failureBehavior: FailurePolicy.FailFast,
      continueOnFailure: false,
      stopOnFailure: true,
      fallbackAllowed: false,
      maxSteps: 1,
      maxTotalExecutionTimeMs:
        request.limits?.globalTimeoutMs ?? ADMIN_DEFAULT_LIMITS.globalTimeoutMs,
    };
    const outcome = await this.invokeExecutor(
      {
        executionId,
        stepId: `admin:${route.agentId}:single`,
        agentId: route.agentId,
        inputs: this.sharedInputs(request, context, route.capabilityId),
        policy,
        traceId: request.traceId ?? `admin:${request.correlationId}`,
      },
      request,
      route.agentId,
    );
    if (!outcome.success) {
      this.emit('ADMIN_AGENT_FAILED', request, {
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

    this.emit('ADMIN_AGENT_COMPLETED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'single',
    });
    const toolTrack = await this.runRequiredTools(request, route.agentId);
    const output = outcome.output as Record<string, unknown> | undefined;
    this.recordInsufficientDataIfNeeded(request, output, route.agentId);
    const recommendations = this.buildRecommendations(request, route.agentId, [output]);
    const status: AdminRequestStatus = 'COMPLETED';
    this.metrics.recordCompleted(Date.now() - startMs);
    return {
      adminRequestId: request.adminRequestId,
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
    request: AdminRequest,
    context: AdminContext,
    route: SingleRoute,
    startedAt: string,
    startMs: number,
  ): Promise<AdminResult> {
    if (this.agenticLoop === undefined || this.toolClient === undefined) {
      this.metrics.recordAgenticRun(false);
      const error = {
        code: ADMIN_AI_ERROR_CODES.AGENT_REJECTED,
        message: 'Agentic mode was requested but the agentic stack is not configured',
      };
      return this.failedResult(request, startedAt, startMs, error, context, route.agentId);
    }
    this.emit('ADMIN_AGENT_STARTED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'agentic',
    });
    const namespace = request.actor.namespaces[0] ?? 'default';
    const outcome = await runAdminAgenticTask({
      loop: this.agenticLoop,
      actor: adminToolActor(route.agentId, request.actor),
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
        timeoutMs: request.limits?.timeoutMs ?? ADMIN_DEFAULT_LIMITS.defaultTaskTimeoutMs,
        signal: request.cancellation?.signal,
      },
    });
    if (outcome.status !== 'COMPLETED') {
      this.metrics.recordAgenticRun(false);
      this.emit('ADMIN_AGENT_FAILED', request, {
        agentId: route.agentId,
        reasonCode: outcome.errorCode ?? outcome.status,
      });
      const error = {
        code: outcome.errorCode ?? ADMIN_AI_ERROR_CODES.COORDINATION_FAILED,
        message: outcome.clarification ?? outcome.errorCode ?? 'Agentic run did not complete',
      };
      return this.failedResult(request, startedAt, startMs, error, context, route.agentId);
    }
    this.metrics.recordAgenticRun(true);
    this.emit('ADMIN_AGENT_COMPLETED', request, {
      agentId: route.agentId,
      capabilityId: route.capabilityId,
      taskId: 'agentic',
    });
    this.emit('ADMIN_TOOL_USED', request, {
      agentId: route.agentId,
      count: outcome.toolCallCount,
    });
    if (outcome.toolCallCount > 0) {
      this.metrics.recordToolCall(outcome.toolSuccessCount === outcome.toolCallCount);
    }
    this.metrics.recordCompleted(Date.now() - startMs);
    return {
      adminRequestId: request.adminRequestId,
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
    request: AdminRequest,
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
        actor: adminToolActor(agentId, request.actor),
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
      this.emit('ADMIN_TOOL_USED', request, {
        agentId,
        count: 1,
        reasonCode: outcome.errorCode,
      });
    }
    return { toolUsage, warnings };
  }

  private async invokeExecutor(
    request: AgentExecutionRequest,
    adminRequest: AdminRequest,
    agentId: string,
  ): Promise<ExecutionOutcome> {
    const executor = this.executorRegistry.resolve(agentId);
    if (executor === undefined || !executor.canExecute(agentId)) {
      throw new AdminAIError(
        ADMIN_AI_ERROR_CODES.AGENT_REJECTED,
        `No executor can drive agent ${agentId}`,
      );
    }
    const startedMs = Date.now();
    const onAbort = () => {
      void executor.cancel(request.executionId);
    };
    const signal = adminRequest.cancellation?.signal;
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
    request: AdminRequest,
    context: AdminContext,
    workflowId: string,
    startedAt: string,
    startMs: number,
  ): Promise<AdminResult> {
    this.emit('ADMIN_WORKFLOW_STARTED', request, { workflowId, routeKind: 'workflow' });
    const coordinationRequest = this.workflows.build(request, context, workflowId);
    const coordinationResult = await this.coordination.coordinate(coordinationRequest);
    const status = this.mapCoordinationStatus(coordinationResult);
    if (status === 'FAILED') {
      this.metrics.recordCoordinationFailure();
      this.emit('ADMIN_WORKFLOW_FAILED', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
        status,
      });
    } else if (status === 'CANCELLED') {
      this.emit('ADMIN_WORKFLOW_CANCELLED', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
      });
      this.metrics.recordCancelled();
    } else if (status === 'TIMED_OUT') {
      this.emit('ADMIN_WORKFLOW_TIMEOUT', request, {
        workflowId,
        coordinationId: coordinationResult.coordinationId,
      });
      this.metrics.recordTimeout();
    }

    const sections = toSectionsFromCoordination(coordinationResult);
    const outputs = aggregationOutputs(coordinationResult);
    this.recordInsufficientDataIfNeeded(request, Object.fromEntries(outputs), 'admin-executive');
    const recommendations = this.buildRecommendations(
      request,
      ADMIN_AGENT_IDS.executive,
      Object.values(outputs).map((value) =>
        typeof value === 'object' && value !== null ? value : undefined,
      ),
    );
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
      adminRequestId: request.adminRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: 'workflow',
      agents,
      response: this.describeExecutiveReview(status, outputs),
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

  private async buildContext(request: AdminRequest): Promise<AdminContext> {
    const input = request.input;
    const analyticsQuery = typeof input.analytics?.query === 'string' ? input.analytics.query : '';
    const actionKind = input.action?.kind ?? '';
    const keywordParts: readonly string[] = [
      ...(typeof actionKind === 'string' && actionKind.trim().length > 0
        ? [actionKind as string]
        : []),
      ...(typeof input.fraud?.policyScope === 'string' && input.fraud.policyScope.trim().length > 0
        ? [input.fraud.policyScope as string]
        : []),
      ...(typeof input.executive?.period === 'string' && input.executive.period.trim().length > 0
        ? [input.executive.period as string]
        : []),
    ];
    const brief = analyticsQuery.length > 0 ? analyticsQuery : (keywordParts[0] ?? '');
    return this.contextBuilder.build({
      actor: request.actor,
      traceId: request.traceId,
      query: {
        brief: String(brief).slice(0, 4096),
        keywords: keywordParts.slice(0, 8),
      },
      namespaces: request.actor.namespaces,
    });
  }

  private sharedInputs(
    request: AdminRequest,
    context: AdminContext,
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
      'admin.capability': capabilityId,
      // BR-ADM-1: agent-level re-enforcement of role scopes (never expanded).
      'admin.scopes': request.actor.adminScopes ?? [],
      // Test/observability knob: deterministic latency for cancellation and
      // timeout scenarios (0..5000 ms). Never exposed to agent logic.
      ...(readKnobNumber(request.metadata, 'admin.delayMs') !== undefined
        ? { 'admin.delayMs': readKnobNumber(request.metadata, 'admin.delayMs') }
        : {}),
    };
  }

  /** Counts & emits an insufficient-data report when the output says so. */
  private recordInsufficientDataIfNeeded(
    request: AdminRequest,
    output: unknown,
    agentId: string,
  ): void {
    if (hasInsufficientDataSignal(output)) {
      this.metrics.recordInsufficientData();
      this.emit('ADMIN_INSUFFICIENT_DATA', request, {
        agentId,
        capabilityId: request.task?.capabilityId,
        count: 1,
      });
    }
  }

  /**
   * Extracts, stamps and reports recommendations from agent outputs. Mutating
   * recommendations are stamped approval-required (BR-ADM-2) and counted;
   * privileged requests are surfaced as audit events (BR-ADM-3).
   */
  private buildRecommendations(
    request: AdminRequest,
    agentId: string,
    outputs: readonly (Record<string, unknown> | undefined)[],
  ): readonly AdminRecommendation[] {
    const raw = extractRecommendations(outputs);
    const recommendations = raw.map(stampRecommendationApproval);
    if (recommendations.length > 0) {
      this.emit('ADMIN_RECOMMENDATION_GENERATED', request, {
        agentId,
        count: recommendations.length,
      });
    }
    const approvalRequired = recommendations.filter((item) => item.approvalRequired === true);
    if (approvalRequired.length > 0) {
      approvalRequired.forEach(() => this.metrics.recordApprovalRequired());
      this.emit('ADMIN_PRIVILEGED_ACTION_REQUESTED', request, {
        agentId,
        count: approvalRequired.length,
      });
    }
    return recommendations;
  }

  private finalizeFromOutcome(
    request: AdminRequest,
    startedAt: string,
    startMs: number,
    outcome: ExecutionOutcome,
    sections: readonly AdminSection[],
    context: AdminContext,
    agentId: string,
  ): AdminResult {
    const code = outcome.error?.code ?? ADMIN_AI_ERROR_CODES.COORDINATION_FAILED;
    const timedOut =
      code === 'EXECUTION_TIMEOUT_ERROR' ||
      code === 'EXECUTION_TIMED_OUT' ||
      code === 'COORDINATION_TIMEOUT';
    const cancelled = code === 'EXECUTION_CANCELLED' || code === 'COORDINATION_CANCELLED';
    let status: AdminRequestStatus = 'FAILED';
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
      message: outcome.error?.message ?? 'Admin agent execution failed',
    };
    return {
      adminRequestId: request.adminRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: 'single',
      agents: [agentId],
      response: `The admin request could not be completed (${code}).`,
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
    request: AdminRequest,
    startedAt: string,
    startMs: number,
    error: unknown,
    _tag: string,
  ): AdminResult {
    const mapped = error instanceof AdminAIError ? error : toAdminAIError(error);
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
    request: AdminRequest,
    startedAt: string,
    startMs: number,
    error: { code: string; message: string },
    context: AdminContext,
    agentId: string | undefined,
  ): AdminResult {
    const timedOut = error.code === ADMIN_AI_ERROR_CODES.COORDINATION_TIMEOUT;
    const cancelled =
      error.code === ADMIN_AI_ERROR_CODES.CANCELLED || request.cancellation?.requested === true;
    const status: AdminRequestStatus = timedOut ? 'TIMED_OUT' : cancelled ? 'CANCELLED' : 'FAILED';
    if (timedOut) {
      this.metrics.recordTimeout();
    } else if (cancelled) {
      this.metrics.recordCancelled();
    }
    return {
      adminRequestId: request.adminRequestId,
      correlationId: request.correlationId,
      requestId: request.requestId,
      traceId: request.traceId,
      status,
      intent: request.intent,
      routeKind: undefined,
      agents: agentId === undefined ? [] : [agentId],
      response: `The admin request could not be completed (${error.code}).`,
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

  private describeExecutiveReview(
    status: AdminRequestStatus,
    outputs: ReadonlyMap<string, unknown>,
  ): string {
    const parts: string[] = [];
    const analytics = (
      outputs.get('analytics') as
        | { analytics?: { dataSufficient?: boolean; measureDefinitions?: readonly unknown[] } }
        | undefined
    )?.analytics;
    if (analytics !== undefined) {
      parts.push(
        analytics.dataSufficient === false
          ? 'Analytics: no data question or aggregated facts supplied.'
          : `Analytics: ${analytics.measureDefinitions?.length ?? 0} measure definition${(analytics.measureDefinitions?.length ?? 0) === 1 ? '' : 's'} derived (values must come from the analytics pipeline, F21).`,
      );
    }
    const health = (
      outputs.get('health') as
        { health?: { breaches?: readonly unknown[]; incidents?: readonly unknown[] } } | undefined
    )?.health;
    if (health !== undefined) {
      const breachCount = health.breaches?.length ?? 0;
      const incidentCount = health.incidents?.length ?? 0;
      parts.push(
        breachCount > 0 || incidentCount > 0
          ? `Health: ${breachCount} metric breach${breachCount === 1 ? '' : 'es'}, ${incidentCount} service incident${incidentCount === 1 ? '' : 's'}.`
          : 'Health: reported metrics within threshold; no incidents.',
      );
    }
    const fraud = (
      outputs.get('fraud') as
        { fraud?: { reviewedSignals?: readonly unknown[]; dataSufficient?: boolean } } | undefined
    )?.fraud;
    if (fraud !== undefined) {
      parts.push(
        fraud.dataSufficient === false
          ? 'Fraud: no signals supplied — nothing was triaged.'
          : `Fraud: ${fraud.reviewedSignals?.length ?? 0} signal${(fraud.reviewedSignals?.length ?? 0) === 1 ? '' : 's'} triaged; any action needs two-admin approval (BR-ADM-2).`,
      );
    }
    if (parts.length === 0) {
      return `Executive review compiled (${status}).`;
    }
    return sanitizeResponse(`Executive review: ${parts.join(' ')}`);
  }

  private mapCoordinationStatus(result: CoordinationResult): AdminRequestStatus {
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
    type: Parameters<AdminAIEventLog['append']>[0]['type'],
    request: AdminRequest,
    metadata: Record<string, unknown> = {},
  ): void {
    this.eventLog.append({
      type,
      occurredAt: new Date().toISOString(),
      success: type.endsWith('FAILED') ? false : undefined,
      metadata: {
        adminRequestId: request.adminRequestId,
        correlationId: request.correlationId,
        traceId: request.traceId,
        requestId: request.requestId,
        ...metadata,
      },
    });
  }
}

const EMPTY_CONTEXT: AdminContext = {
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

function toSectionsFromCoordination(result: CoordinationResult): readonly AdminSection[] {
  return result.tasks.map((task: TaskResult): AdminSection => {
    const status: AdminSection['status'] =
      task.status === TaskStatus.Completed
        ? 'success'
        : task.status === TaskStatus.Skipped
          ? 'skipped'
          : 'failure';
    return {
      taskId: task.taskId,
      agentId: task.agentId,
      capability: 'admin.task',
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
): readonly AdminSection[] {
  return entries.map((entry) => ({
    agentId: entry.agentId,
    capability: 'admin.task',
    status: 'success' as const,
    output:
      entry.output !== undefined && typeof entry.output === 'object'
        ? (entry.output as Record<string, unknown>)
        : undefined,
  }));
}

function extractRecommendations(
  outputs: readonly (Record<string, unknown> | undefined)[],
): readonly AdminRecommendation[] {
  const out: AdminRecommendation[] = [];
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
            actionKind?: 'read' | 'mutating';
            priority?: 'low' | 'medium' | 'high';
            confidence?: number;
          };
          out.push({
            agentId: candidate.agentId ?? '',
            capability: candidate.capability ?? '',
            title: candidate.title ?? 'Admin recommendation',
            recommendation: String(candidate.recommendation),
            actionKind: candidate.actionKind,
            priority: candidate.priority,
            confidence: candidate.confidence,
          });
        }
      }
    }
  }
  return out;
}

function agenticUserInput(request: AdminRequest): string {
  const input = request.input;
  const candidate =
    input.analytics?.query ??
    input.action?.kind ??
    (typeof input.fraud?.policyScope === 'string' ? input.fraud.policyScope : '') ??
    '';
  return candidate.trim().length > 0 ? candidate : 'Review my admin request';
}

function describeOutput(agentId: string, output: Record<string, unknown>): string {
  const action = output['action'] as
    | {
        mutating?: boolean;
        approvalsRequired?: number;
        actionKind?: string;
        dataSufficient?: boolean;
        note?: string;
      }
    | undefined;
  if (action !== undefined) {
    if (action.dataSufficient === false) {
      return 'Admin action review pending — supply an action kind and, when relevant, a domain.';
    }
    return action.mutating === true
      ? `Admin action "${action.actionKind ?? ''}" classified as sensitive — ${action.approvalsRequired ?? 0} approvals required (BR-ADM-2); nothing is executed.`
      : `Admin action "${action.actionKind ?? ''}" classified as advisory (read); no automated action taken.`;
  }

  const analytics = output['analytics'] as
    | {
        dataSufficient?: boolean;
        queryComplexity?: number;
        measureDefinitions?: readonly unknown[];
        chartKind?: string;
      }
    | undefined;
  if (analytics !== undefined) {
    if (analytics.dataSufficient === false) {
      return 'Analytics: no data question or aggregated facts supplied — nothing is claimed (F21).';
    }
    return `Analytics: ${analytics.measureDefinitions?.length ?? 0} measure definition${(analytics.measureDefinitions?.length ?? 0) === 1 ? '' : 's'} derived (complexity ${analytics.queryComplexity ?? 0}, ${analytics.chartKind ?? 'bar'} chart guidance). Values must come from the analytics pipeline — never fabricated.`;
  }

  const fraud = output['fraud'] as
    | {
        dataSufficient?: boolean;
        reviewedSignals?: readonly unknown[];
        highRiskCount?: number;
        noAutoBans?: boolean;
      }
    | undefined;
  if (fraud !== undefined) {
    if (fraud.dataSufficient === false) {
      return 'Fraud: no signals supplied — no alert is fabricated or auto-ban executed.';
    }
    return `Fraud: ${fraud.reviewedSignals?.length ?? 0} signal${(fraud.reviewedSignals?.length ?? 0) === 1 ? '' : 's'} triaged, ${fraud.highRiskCount ?? 0} high risk; no auto-ban (${fraud.noAutoBans === true ? 'BR-ADM-2' : 'unexpected state'}).`;
  }

  const health = output['health'] as
    | {
        dataSufficient?: boolean;
        breaches?: readonly unknown[];
        incidents?: readonly unknown[];
        degraded?: boolean;
      }
    | undefined;
  if (health !== undefined) {
    if (health.dataSufficient === false) {
      return 'Health: no observed metrics or topology supplied — no health claim is made.';
    }
    const issues = (health.breaches?.length ?? 0) + (health.incidents?.length ?? 0);
    void issues;
    return health.degraded === true
      ? `Health: degraded — ${health.breaches?.length ?? 0} breach${(health.breaches?.length ?? 0) === 1 ? '' : 'es'}, ${health.incidents?.length ?? 0} incident${(health.incidents?.length ?? 0) === 1 ? '' : 's'}.`
      : `Health: ${health.breaches?.length ?? 0} breach${(health.breaches?.length ?? 0) === 1 ? '' : 'es'}, ${health.incidents?.length ?? 0} incident${(health.incidents?.length ?? 0) === 1 ? '' : 's'} — within reported tolerances.`;
  }

  const aiops = output['aiops'] as
    | {
        dataSufficient?: boolean;
        changeType?: string;
        changeTarget?: string;
        approvalRequired?: boolean;
        reversible?: boolean;
      }
    | undefined;
  if (aiops !== undefined) {
    if (aiops.dataSufficient === false) {
      return 'AI Operations: no change proposal or cost facts supplied — nothing is proposed or modified.';
    }
    return aiops.changeType !== undefined
      ? `AI Operations: ${aiops.changeType} on "${aiops.changeTarget ?? ''}" assessed as ${aiops.reversible === true ? 'reversible' : 'not-reversible'} rollout — approval required (${aiops.approvalRequired === true ? 'BR-ADM-2/4' : 'unexpected state'}); never executed by AI.`
      : 'AI Operations: cost facts reported; no change proposed.';
  }

  const executive = output['executive'] as
    | {
        dataSufficient?: boolean;
        kpis?: readonly unknown[];
        aggregatedOnly?: boolean;
        anomalies?: readonly unknown[];
      }
    | undefined;
  if (executive !== undefined) {
    if (executive.dataSufficient === false) {
      return 'Executive: no aggregated KPI facts supplied — totals are never invented.';
    }
    return `Executive: ${executive.kpis?.length ?? 0} aggregated KPI fact${(executive.kpis?.length ?? 0) === 1 ? '' : 's'} reviewed (${executive.aggregatedOnly === true ? 'aggregated only' : 'unexpected state'}), ${executive.anomalies?.length ?? 0} flagged.`;
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
