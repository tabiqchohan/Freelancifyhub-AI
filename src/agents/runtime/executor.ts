import type { Logger } from 'pino';

import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutor,
  ExecutionError,
  ExecutorRegistry,
} from '../ag-001-master-orchestrator/execution/index.js';
import { toExecutionError } from '../ag-001-master-orchestrator/execution/index.js';
import type {
  ContextItem,
  MemoryContextLoadInput,
  MemoryContextProvider,
} from '../ag-001-master-orchestrator/context/index.js';
import type { AgentId } from '../ag-001-master-orchestrator/types/index.js';
import { AgentStatus } from '../ag-001-master-orchestrator/types/index.js';
import { createOrchestratorLogger } from '../ag-001-master-orchestrator/utils/logger.js';
import type {
  CancellationSignal,
  RuntimeAgentEvent,
  RuntimeAgentEventType,
  RuntimeAgentExecutionResult,
  RuntimeMemoryItem,
} from './types.js';
import { RuntimeAgentEventType as RuntimeAgentEventTypeValue } from './types.js';
import type { AgentRegistry } from './registry.js';
import { LLM_AGENTIC_CAPABILITY, LLM_REASONING_CAPABILITY } from '../../llm/constants.js';
import { classifyLLMError } from '../../llm/errors/index.js';
import type { AIReasoningServiceContract } from '../../llm/types/index.js';
import type { LLMUsage } from '../../llm/types/index.js';
import { AgenticLoopStatus } from './agentic/contracts.js';
import type { AgenticLoopService } from './agentic/loop.js';
import type { ToolActor } from '../ag-004-tool-manager/index.js';
import { ToolActorGroup } from '../ag-004-tool-manager/index.js';
import type { AgentPlatformGateway } from '../agent-platform/gateway.js';
import { AgentExecutionMode } from '../agent-platform/types.js';
import type { AgentExecutionLease } from '../agent-platform/types.js';

/** Builds the AG-002 memory load input for a given execution request. */
export type MemoryContextInputBuilder = (
  request: AgentExecutionRequest,
) => MemoryContextLoadInput | undefined;

/** Options for constructing a {@link ProductionAgentExecutor}. */
export interface ProductionAgentExecutorOptions {
  readonly registry: AgentRegistry;
  readonly memoryProvider?: MemoryContextProvider;
  readonly memoryInputBuilder?: MemoryContextInputBuilder;
  readonly defaultTimeoutMs?: number;
  readonly logger?: Logger;
  readonly onEvent?: (event: RuntimeAgentEvent) => void;
  /** AI reasoning capability; required by agents declaring `agent.reasoning`. */
  readonly reasoningService?: AIReasoningServiceContract;
  /** Agentic tool-calling loop; required by agents declaring `agent.agentic`. */
  readonly agenticLoop?: AgenticLoopService;
  /** Builds the AG-004 actor for a request's agentic execution. */
  readonly agenticToolActor?: AgenticToolActorBuilder;
  /** Optional Sprint 19 platform gate. When present, platform-managed agents
   * must pass `beginExecution` before any work; the lease is closed in a
   * finally block regardless of outcome. Unmanaged agents are untouched. */
  readonly agentPlatform?: AgentPlatformGateway;
}

/** A safe actor used to execute agentic tool calls through AG-004. */
export interface AgenticToolActorBuilder {
  (request: AgentExecutionRequest): ToolActor | undefined;
}

/**
 * Outcome of an optional reasoning prelude. When `failed` the request must be
 * answered with a fail-closed {@link ExecutionError}, never with degraded
 * output.
 */
interface ReasoningOutcome {
  readonly failed: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable?: boolean;
  readonly reasoning?: {
    readonly enabled: true;
    readonly output: string;
    readonly provider: string;
    readonly model: string;
    readonly usage?: LLMUsage;
    readonly latencyMs: number;
    readonly correlationId?: string;
    /** Present when the agent ran in agentic tool-calling mode. */
    readonly agentic?: {
      readonly status: AgenticLoopStatus;
      readonly turns: number;
      readonly reasoningCalls: number;
      readonly toolCalls: number;
      readonly rejections: number;
      readonly clarification?: string;
    };
  };
}

/** Internal guard outcome shared by the executor's signal/timeout race. */
type GuardOutcome = 'result' | 'cancelled' | 'timedOut';

/**
 * The production {@link AgentExecutor} (Phase 3).
 *
 * Resolves agents from the {@link AgentRegistry} (never from routing data or
 * hard-coded ids), provisions memory through the AG-001
 * {@link MemoryContextProvider} (AG-002-backed; failures degrade to empty
 * context but are always logged — never silently swallowed, authorization
 * never bypassed), honours retry-by-attempt, per-step timeout and cooperative
 * cancellation, normalises results and emits typed runtime events for the
 * Phase 6 event bridge.
 */
export class ProductionAgentExecutor implements AgentExecutor {
  readonly id = 'production-agent-executor';

  private readonly registry: AgentRegistry;
  private readonly memoryProvider: MemoryContextProvider | undefined;
  private readonly memoryInputBuilder: MemoryContextInputBuilder | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly logger: Logger;
  private readonly onEvent: ((event: RuntimeAgentEvent) => void) | undefined;
  private readonly reasoningService: AIReasoningServiceContract | undefined;
  private readonly agenticLoop: AgenticLoopService | undefined;
  private readonly agenticToolActor: AgenticToolActorBuilder | undefined;
  private readonly agentPlatform: AgentPlatformGateway | undefined;
  private readonly attemptCounters = new Map<string, number>();
  private readonly signals = new Map<string, CancellationSignalImpl>();

  constructor(options: ProductionAgentExecutorOptions) {
    this.registry = options.registry;
    this.memoryProvider = options.memoryProvider;
    this.memoryInputBuilder = options.memoryInputBuilder;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
    this.logger = options.logger ?? createOrchestratorLogger('production-executor');
    this.onEvent = options.onEvent;
    this.reasoningService = options.reasoningService;
    this.agenticLoop = options.agenticLoop;
    this.agenticToolActor = options.agenticToolActor;
    this.agentPlatform = options.agentPlatform;
  }

  canExecute(agentId: AgentId): boolean {
    return this.registry.isAvailable(agentId);
  }

  status(): { readonly available: boolean; readonly details?: Readonly<Record<string, unknown>> } {
    return {
      available: true,
      details: {
        registeredAgents: this.registry.size,
        availableAgents: this.registry.listAvailable().length,
        memoryProvider: this.memoryProvider !== undefined,
        defaultTimeoutMs: this.defaultTimeoutMs,
      },
    };
  }

  /** Marks an execution as cancelled; running agents observe the signal. */
  async cancel(executionId: string): Promise<void> {
    const signal = this.signals.get(executionId);
    if (signal !== undefined) {
      signal.requestCancellation();
      this.emitEvent(RuntimeAgentEventTypeValue.CancellationRequested, {
        executionId,
        agentId: 'AG-001',
        stepId: '',
        requestId: '',
        traceId: '',
        occurredAt: new Date().toISOString(),
        metadata: { source: 'executor.cancel' },
      });
    }
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const startedAt = new Date().toISOString();
    const agentId = request.agentId;
    const traceId = request.traceId ?? `runtime:${request.executionId}`;
    const requestId = parseRequestId(request.executionId);
    const attempt = this.nextAttempt(request.executionId, request.stepId);
    const signal = this.acquireSignal(request.executionId);

    const agent = this.registry.get(agentId);

    if (agent === undefined) {
      this.logger.warn({ executionId: request.executionId, agentId }, 'unknown agent requested');
      return this.failure(
        {
          code: 'AGENT_NOT_FOUND',
          message: `Unknown agent ${agentId} (not registered in the runtime agent registry)`,
          retryable: false,
        },
        startedAt,
        { executionId: request.executionId, traceId, requestId },
      );
    }

    if (!this.isAgentExecutable(agent)) {
      return this.failure(
        {
          code: 'AGENT_UNAVAILABLE',
          message: `Agent ${agentId} is not currently available`,
          retryable: false,
        },
        startedAt,
        { executionId: request.executionId, traceId, requestId },
      );
    }

    // --- Sprint 19 platform gate (managed agents only) ----------------------
    const startedAtMs = performance.now();
    let lease: AgentExecutionLease | undefined;
    if (this.agentPlatform !== undefined && this.agentPlatform.isPlatformManaged(agentId)) {
      const gate = this.agentPlatform.beginExecution({
        executionId: request.executionId,
        requestId,
        traceId,
        correlationId: requestId,
        agentId,
        agentVersion: agent.configuration.version,
        executionMode: this.executionModeFor(agent),
        capabilities: agent.configuration.capabilities.map((capability) => capability.id),
        permissions: agent.configuration.permissions ?? [],
      });

      if (gate.failure !== undefined) {
        this.logger.warn(
          { executionId: request.executionId, agentId, reason: gate.failure.code },
          'platform gate denied execution',
        );
        this.emitEvent(RuntimeAgentEventTypeValue.ExecutionFailed, {
          executionId: request.executionId,
          stepId: request.stepId,
          agentId,
          traceId,
          requestId,
          occurredAt: new Date().toISOString(),
          errorCode: gate.failure.code,
          metadata: { attempt, success: false, stage: 'platform-gate' },
        });
        this.releaseSignal(request.executionId);
        return this.failure(
          {
            code: gate.failure.code,
            message: gate.failure.message,
            retryable: gate.failure.retryable,
          },
          startedAt,
          { executionId: request.executionId, traceId, requestId },
        );
      }
      lease = gate.lease;
    }

    try {
      const memory = await this.provisionMemory(request, {
        executionId: request.executionId,
        stepId: request.stepId,
        agentId,
        traceId,
        requestId,
      });

      const timeoutMs = this.timeoutFor(request);

      const reasoning = await this.resolveReasoning(request, agent, {
        executionId: request.executionId,
        stepId: request.stepId,
        agentId,
        traceId,
        requestId,
        memory,
        signal,
        allowedTools: lease?.allowedTools,
      });

      if (reasoning.failed) {
        this.emitEvent(RuntimeAgentEventTypeValue.ExecutionFailed, {
          executionId: request.executionId,
          stepId: request.stepId,
          agentId,
          traceId,
          requestId,
          occurredAt: new Date().toISOString(),
          errorCode: reasoning.errorCode,
          metadata: { attempt, success: false, stage: 'reasoning' },
        });
        this.releaseSignal(request.executionId);
        return this.failure(
          {
            code: reasoning.errorCode ?? 'REASONING_UNAVAILABLE',
            message: reasoning.errorMessage ?? 'AI reasoning unavailable',
            retryable: reasoning.retryable ?? false,
          },
          startedAt,
          { executionId: request.executionId, traceId, requestId },
        );
      }

      const context = {
        agentId,
        executionId: request.executionId,
        stepId: request.stepId,
        traceId,
        requestId,
        attempt,
        startedAt,
        timeoutMs,
        inputs: request.inputs,
        memory,
        reasoning: reasoning.reasoning,
        signal,
      };

      this.emitEvent(RuntimeAgentEventTypeValue.ExecutionStarted, {
        executionId: request.executionId,
        stepId: request.stepId,
        agentId,
        traceId,
        requestId,
        occurredAt: startedAt,
        metadata: { attempt, agentVersion: agent.configuration.version, provider: 'runtime' },
      });

      let agentResult: RuntimeAgentExecutionResult;
      try {
        agentResult = await this.guard(
          Promise.resolve().then(() => agent.execute(context)),
          signal,
          Math.min(timeoutMs > 0 ? timeoutMs : Infinity, this.defaultTimeoutMs),
        );
      } catch (error) {
        agentResult = {
          success: false,
          error: toExecutionError(error),
        };
      }

      const completedAt = new Date().toISOString();
      const durationMs = Math.max(
        0,
        new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      );
      const result = this.wrapAgentResult(
        agentResult,
        startedAt,
        completedAt,
        durationMs,
        traceId,
        requestId,
        attempt,
      );

      this.emitEvent(
        result.success
          ? RuntimeAgentEventTypeValue.ExecutionCompleted
          : RuntimeAgentEventTypeValue.ExecutionFailed,
        {
          executionId: request.executionId,
          stepId: request.stepId,
          agentId,
          traceId,
          requestId,
          occurredAt: completedAt,
          errorCode: result.success ? undefined : result.error?.code,
          metadata: { attempt, success: result.success },
        },
      );

      this.releaseSignal(request.executionId);
      return result;
    } finally {
      this.closeGate(lease, agentId, request.executionId, requestId, traceId, startedAtMs);
    }
  }

  private async resolveReasoning(
    request: AgentExecutionRequest,
    agent: NonNullable<Awaited<ReturnType<AgentRegistry['get']>>>,
    info: {
      executionId: string;
      stepId: string;
      agentId: AgentId;
      traceId: string;
      requestId: string;
      memory: readonly RuntimeMemoryItem[];
      signal: CancellationSignal;
      allowedTools?: readonly string[];
    },
  ): Promise<ReasoningOutcome> {
    const requiresReasoning = agent.configuration.capabilities.some(
      (capability) => capability.id === LLM_REASONING_CAPABILITY,
    );
    const requiresAgentic = agent.configuration.capabilities.some(
      (capability) => capability.id === LLM_AGENTIC_CAPABILITY,
    );

    if (requiresAgentic) {
      return this.resolveAgenticReasoning(request, info);
    }

    if (!requiresReasoning) {
      return { failed: false };
    }

    if (this.reasoningService === undefined || !this.reasoningService.isEnabled()) {
      return {
        failed: true,
        errorCode: 'REASONING_UNAVAILABLE',
        errorMessage: `Agent ${info.agentId} requires AI reasoning, but it is not enabled in this deployment`,
        retryable: false,
      };
    }

    try {
      const result = await this.reasoningService.reason(
        {
          userInput: extractUserInput(request),
          context: {
            executionId: info.executionId,
            stepId: info.stepId,
            agentId: info.agentId,
          },
          memoryContext: info.memory.map(toReasoningContextItem),
          correlationId: info.requestId,
        },
        { signal: toAbortSignal(info.signal), requestId: info.requestId },
      );
      return {
        failed: false,
        reasoning: {
          enabled: true,
          output: result.output,
          provider: result.provider,
          model: result.model,
          usage: result.usage,
          latencyMs: result.latencyMs,
          correlationId: result.correlationId ?? info.requestId,
        },
      };
    } catch (error) {
      const classification = classifyLLMError(error);
      this.logger.error(
        {
          agentId: info.agentId,
          executionId: info.executionId,
          errorClass: classification.errorClass,
        },
        'reasoning failed for reasoning-capable agent',
      );
      return {
        failed: true,
        errorCode:
          classification.errorClass === 'configuration'
            ? 'REASONING_UNAVAILABLE'
            : classification.errorClass === 'cancelled'
              ? 'REASONING_CANCELLED'
              : 'REASONING_FAILED',
        errorMessage: 'AI reasoning could not be completed for this request',
        retryable: classification.retryable,
      };
    }
  }

  private async resolveAgenticReasoning(
    request: AgentExecutionRequest,
    info: {
      executionId: string;
      stepId: string;
      agentId: AgentId;
      traceId: string;
      requestId: string;
      memory: readonly RuntimeMemoryItem[];
      signal: CancellationSignal;
      allowedTools?: readonly string[];
    },
  ): Promise<ReasoningOutcome> {
    if (this.agenticLoop === undefined || !this.agenticLoop.isEnabled()) {
      return {
        failed: true,
        errorCode: 'REASONING_UNAVAILABLE',
        errorMessage: `Agent ${info.agentId} requires agentic tool-calling, but it is not enabled in this deployment`,
        retryable: false,
      };
    }

    const actor = this.agenticToolActor?.(request) ?? this.defaultAgenticToolActor(info.agentId);

    const result = await this.agenticLoop.run({
      userInput: extractUserInput(request),
      context: {
        executionId: info.executionId,
        stepId: info.stepId,
        agentId: info.agentId,
      },
      memoryContext: info.memory.map(toReasoningContextItem),
      actor,
      namespace: actor.namespaces?.[0] ?? 'default',
      agentId: info.agentId,
      executionId: info.executionId,
      requestId: info.requestId,
      traceId: info.traceId,
      signal: toAbortSignal(info.signal),
      timeoutMs: this.timeoutFor(request),
      allowedTools: info.allowedTools,
    });

    const agentic = {
      status: result.status,
      turns: result.turns,
      reasoningCalls: result.reasoningCalls,
      toolCalls: result.toolCalls.length,
      rejections: result.rejections.length,
      ...(result.clarification !== undefined ? { clarification: result.clarification } : {}),
    };

    if (result.status === AgenticLoopStatus.Completed) {
      if (result.finalResponse === undefined) {
        return {
          failed: true,
          errorCode: 'AGENTIC_LOOP_FAILED',
          errorMessage: 'Agentic loop completed without a final response',
          retryable: false,
        };
      }
      return {
        failed: false,
        reasoning: {
          enabled: true,
          output: result.finalResponse,
          provider: result.provider ?? 'unknown',
          model: result.model ?? 'unknown',
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          },
          latencyMs: result.durationMs,
          correlationId: result.correlationId ?? info.requestId,
          agentic,
        },
      };
    }

    if (result.status === AgenticLoopStatus.Clarification) {
      return {
        failed: false,
        reasoning: {
          enabled: true,
          output: result.clarification ?? '',
          provider: result.provider ?? 'unknown',
          model: result.model ?? 'unknown',
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          },
          latencyMs: result.durationMs,
          correlationId: result.correlationId ?? info.requestId,
          agentic,
        },
      };
    }

    if (result.status === AgenticLoopStatus.Aborted) {
      return {
        failed: false,
        reasoning: {
          enabled: true,
          output: result.finalResponse ?? '',
          provider: result.provider ?? 'unknown',
          model: result.model ?? 'unknown',
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          },
          latencyMs: result.durationMs,
          correlationId: result.correlationId ?? info.requestId,
          agentic,
        },
      };
    }

    const terminalError = this.agenticTerminalError(result.status);
    return {
      failed: true,
      errorCode: terminalError.errorCode,
      errorMessage: terminalError.errorMessage,
      retryable: result.retryable ?? false,
    };
  }

  private agenticTerminalError(status: AgenticLoopStatus): {
    errorCode: string;
    errorMessage: string;
  } {
    switch (status) {
      case AgenticLoopStatus.Cancelled:
        return {
          errorCode: 'AGENTIC_LOOP_CANCELLED',
          errorMessage: 'Agentic tool-calling was cancelled',
        };
      case AgenticLoopStatus.TimedOut:
        return {
          errorCode: 'AGENTIC_LOOP_TIMEOUT',
          errorMessage: 'Agentic tool-calling exceeded its deadline',
        };
      case AgenticLoopStatus.LimitReached:
        return {
          errorCode: 'AGENTIC_LOOP_LIMIT_REACHED',
          errorMessage: 'Agentic tool-calling exceeded its limits',
        };
      case AgenticLoopStatus.Failed:
      default:
        return {
          errorCode: 'AGENTIC_LOOP_FAILED',
          errorMessage: 'Agentic tool-calling failed for this request',
        };
    }
  }

  private get defaultAgenticNamespace(): string {
    return 'default';
  }

  private defaultAgenticToolActor(agentId: string): ToolActor {
    return {
      group: ToolActorGroup.Orchestrator,
      id: `${agentId}-agentic`,
      namespaces: [this.defaultAgenticNamespace],
    };
  }

  private async provisionMemory(
    request: AgentExecutionRequest,
    info: {
      executionId: string;
      stepId: string;
      agentId: AgentId;
      traceId: string;
      requestId: string;
    },
  ): Promise<readonly RuntimeMemoryItem[]> {
    if (this.memoryProvider === undefined || this.memoryInputBuilder === undefined) {
      return [];
    }

    const input = this.memoryInputBuilder(request);
    if (input === undefined || input.namespaces.length === 0) {
      return [];
    }

    this.emitEvent(RuntimeAgentEventTypeValue.MemoryRetrievalStarted, {
      executionId: info.executionId,
      stepId: info.stepId,
      agentId: info.agentId,
      traceId: info.traceId,
      requestId: info.requestId,
      occurredAt: new Date().toISOString(),
      metadata: { namespaces: input.namespaces, query: input.query, actorGroup: input.actorGroup },
    });

    try {
      const items = await this.memoryProvider.load(input);
      const memory = items.map(toRuntimeMemoryItem);
      this.emitEvent(RuntimeAgentEventTypeValue.MemoryRetrievalSucceeded, {
        executionId: info.executionId,
        stepId: info.stepId,
        agentId: info.agentId,
        traceId: info.traceId,
        requestId: info.requestId,
        occurredAt: new Date().toISOString(),
        metadata: { included: memory.length },
      });
      return memory;
    } catch (error) {
      const normalized = toExecutionError(error);
      this.logger.error(
        { executionId: info.executionId, errorCode: normalized.code },
        'memory retrieval degraded to empty context',
      );
      this.emitEvent(RuntimeAgentEventTypeValue.MemoryRetrievalFailed, {
        executionId: info.executionId,
        stepId: info.stepId,
        agentId: info.agentId,
        traceId: info.traceId,
        requestId: info.requestId,
        occurredAt: new Date().toISOString(),
        errorCode: normalized.code,
      });
      return [];
    }
  }

  private wrapAgentResult(
    agentResult: RuntimeAgentExecutionResult,
    startedAt: string,
    completedAt: string,
    durationMs: number,
    traceId: string,
    requestId: string,
    attempt: number,
  ): AgentExecutionResult {
    if (agentResult.success === true) {
      return {
        success: true,
        output: agentResult.output,
        startedAt,
        completedAt,
        durationMs,
        metadata: agentResult.metadata ?? { provider: 'runtime', attempt },
      };
    }

    const error: ExecutionError = agentResult.error ?? {
      code: 'AGENT_EXECUTION_FAILED',
      message: 'Agent execution failed',
      retryable: true,
    };

    return {
      success: false,
      error,
      startedAt,
      completedAt,
      durationMs,
      metadata: { provider: 'runtime', attempt, traceId, requestId },
    };
  }

  private failure(
    error: ExecutionError,
    startedAt: string,
    info: { executionId: string; traceId: string; requestId: string },
  ): AgentExecutionResult {
    const completedAt = new Date().toISOString();
    return {
      success: false,
      error,
      startedAt,
      completedAt,
      durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
      metadata: {
        provider: 'runtime',
        traceId: info.traceId,
        requestId: info.requestId,
        executionId: info.executionId,
      },
    };
  }

  private isAgentExecutable(agent: Awaited<ReturnType<AgentRegistry['get']>>): boolean {
    return (
      agent !== undefined &&
      agent.availability.available &&
      agent.configuration.status !== AgentStatus.Retired
    );
  }

  /** Effective Sprint 19 execution mode mirroring resolveReasoning precedence. */
  private executionModeFor(
    agent: NonNullable<Awaited<ReturnType<AgentRegistry['get']>>>,
  ): AgentExecutionMode {
    if (
      agent.configuration.capabilities.some(
        (capability) => capability.id === LLM_AGENTIC_CAPABILITY,
      )
    ) {
      return AgentExecutionMode.Agentic;
    }
    if (
      agent.configuration.capabilities.some(
        (capability) => capability.id === LLM_REASONING_CAPABILITY,
      )
    ) {
      return AgentExecutionMode.Reasoning;
    }
    return AgentExecutionMode.Deterministic;
  }

  /** Closes a platform gate lease when one was opened (idempotent, finally-safe). */
  private closeGate(
    lease: AgentExecutionLease | undefined,
    agentId: AgentId,
    executionId: string,
    requestId: string,
    traceId: string,
    startedAtMs: number,
  ): void {
    if (lease === undefined || this.agentPlatform === undefined) {
      return;
    }
    this.agentPlatform.endExecution({
      agentId,
      executionId,
      requestId,
      traceId,
      startedAtMs,
    });
  }

  private timeoutFor(request: AgentExecutionRequest): number {
    if (request.policy.timeoutMs > 0) {
      return request.policy.timeoutMs;
    }
    return this.defaultTimeoutMs;
  }

  private nextAttempt(executionId: string, stepId: string): number {
    const key = `${executionId}:${stepId}`;
    const next = (this.attemptCounters.get(key) ?? 0) + 1;
    this.attemptCounters.set(key, next);
    return next;
  }

  private acquireSignal(executionId: string): CancellationSignalImpl {
    let signal = this.signals.get(executionId);
    if (signal === undefined) {
      signal = new CancellationSignalImpl();
      this.signals.set(executionId, signal);
    }
    return signal;
  }

  private releaseSignal(executionId: string): void {
    this.signals.delete(executionId);
  }

  private async guard(
    work: Promise<RuntimeAgentExecutionResult>,
    signal: CancellationSignal,
    timeoutMs: number,
  ): Promise<RuntimeAgentExecutionResult> {
    // The work promise is wrapped as a tagged object so it can be distinguished
    // from the guard's string outcomes in the race below.
    const workOutcome = work.then((result) => ({ kind: 'result' as const, result }));
    const raced = await Promise.race<
      { kind: 'result'; result: RuntimeAgentExecutionResult } | GuardOutcome
    >([workOutcome, this.guardPromise(signal, timeoutMs)]);

    if (raced !== null && typeof raced === 'object' && raced.kind === 'result') {
      return raced.result;
    }
    if (raced === 'cancelled') {
      return {
        success: false,
        error: {
          code: 'EXECUTION_CANCELLED',
          message: 'Execution was cancelled before the agent completed',
          retryable: false,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'EXECUTION_TIMEOUT_ERROR',
        message: `Agent execution exceeded the ${timeoutMs}ms safety timeout`,
        retryable: false,
      },
    };
  }

  private guardPromise(signal: CancellationSignal, timeoutMs: number): Promise<GuardOutcome> {
    return new Promise<GuardOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: GuardOutcome): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(outcome);
        }
      };
      const explicitTimeout = timeoutMs > 0 && Number.isFinite(timeoutMs) ? timeoutMs : Infinity;
      const timer = setTimeout(() => settle('timedOut'), explicitTimeout);
      void signal.waitForCancellation().then(() => settle('cancelled'));
    });
  }

  private emitEvent(type: RuntimeAgentEventType, event: Omit<RuntimeAgentEvent, 'type'>): void {
    if (this.onEvent === undefined) {
      return;
    }
    try {
      this.onEvent({ type, ...event });
    } catch (error) {
      this.logger.warn({ error }, 'runtime event bridge failed (non-fatal)');
    }
  }
}

/** Production executor registry: exposes the executor only for available agents. */
export class ProductionExecutorRegistry implements ExecutorRegistry {
  private readonly executor: ProductionAgentExecutor;

  constructor(executor: ProductionAgentExecutor) {
    this.executor = executor;
  }

  resolve(agentId: AgentId): AgentExecutor | undefined {
    if (this.executor.canExecute(agentId) && this.executor.status().available) {
      return this.executor;
    }
    return undefined;
  }
}

/** Internal cancellable signal implementation used per execution. */
class CancellationSignalImpl implements CancellationSignal {
  private cancelled = false;
  private waiters: readonly (() => void)[] = [];

  get requested(): boolean {
    return this.cancelled;
  }

  requestCancellation(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const resolve of this.waiters) {
      resolve();
    }
    this.waiters = [];
  }

  waitForCancellation(): Promise<void> {
    if (this.cancelled) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters = [...this.waiters, resolve];
    });
  }
}

/** Maps an AG-001 memory context item into a runtime agent memory item. */
function toRuntimeMemoryItem(item: ContextItem): RuntimeMemoryItem {
  const metadata = item.metadata ?? {};
  return {
    id: item.id,
    namespace: metadata['namespace'] as RuntimeMemoryItem['namespace'],
    key: String(metadata['key'] ?? ''),
    content: item.content,
    priority: metadata['type'] as string,
    source: item.source.type,
    securityLevel: metadata['securityLevel'] as RuntimeMemoryItem['securityLevel'],
    tokenEstimate: typeof metadata['tokenEstimate'] === 'number' ? metadata['tokenEstimate'] : 0,
  };
}

/** Derives the orchestrator request id from an execution id (`exec_<requestId>`). */
function parseRequestId(executionId: string): string {
  const match = /^exec_(.+)$/.exec(executionId);
  return match !== null ? match[1]! : executionId;
}

/** Extracts the primary user text from execution inputs (empty when absent). */
function extractUserInput(request: AgentExecutionRequest): string {
  const raw =
    request.inputs['request.input'] ?? request.inputs['input'] ?? request.inputs['text'] ?? '';
  return typeof raw === 'string' ? raw : '';
}

/** Maps a runtime memory item into a reasoning-ready context item (no metadata). */
function toReasoningContextItem(item: RuntimeMemoryItem): {
  readonly id: string;
  readonly source: string;
  readonly content: string;
  readonly securityLevel?: string;
  readonly namespace?: string;
} {
  return {
    id: item.id,
    source: item.source,
    content: item.content,
    securityLevel: item.securityLevel,
    namespace: item.namespace,
  };
}

/** Bridges the runtime cooperative {CancellationSignal} into an {AbortSignal}. */
function toAbortSignal(signal: CancellationSignal): AbortSignal {
  const controller = new AbortController();
  if (signal.requested) {
    controller.abort();
    return controller.signal;
  }
  void signal.waitForCancellation().then(() => controller.abort());
  return controller.signal;
}
