/**
 * Sprint 24 — Marketing AI Team v1. Tool + agentic integration.
 *
 * Tools are executed strictly through AG-004 with the platform gateway's
 * allowlist enforced (never bypassed). Agentic reasoning, when enabled at the
 * composition level, runs through the Sprint 18 agentic loop with AG-004 tools
 * and the authorized marketing tool actor. Both paths fail closed: an
 * unauthorized tool is denied before any execution and never leaks internals.
 * v1 marketing agents ship with an empty allowlist, so every path below
 * refuses agentic tool access unless explicitly overridden at composition.
 */

import type { AgentPlatformGateway } from '../agent-platform/gateway.js';
import type {
  ToolActor,
  ToolExecutionContext,
  ToolResult,
  ToolManagerService,
} from '../ag-004-tool-manager/index.js';
import { ToolActorGroup, ToolResultStatus } from '../ag-004-tool-manager/index.js';
import type { AgenticLoopResult, AgenticLoopService } from '../runtime/agentic/index.js';
import type { ReasoningContextItem } from '../../llm/types/index.js';
import { MarketingAIError, MARKETING_AI_ERROR_CODES } from './errors.js';
import { safeMarketingValue } from './security.js';
import type { MarketingContext } from './types.js';

/** Normalized, safe outcome of one marketing tool call. */
export interface MarketingToolOutcome {
  readonly success: boolean;
  readonly toolId: string;
  readonly toolName: string;
  readonly status: ToolResultStatus;
  readonly output?: unknown;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly durationMs: number;
}

/** Options for the marketing tool client. */
export interface MarketingToolClientOptions {
  readonly gateway: AgentPlatformGateway;
  readonly toolManager: ToolManagerService;
}

/**
 * Authorized AG-004 marketing tool adapter. Enforces the platform tool
 * allowlist and always runs with a Marketing-group actor (never with
 * escalated scope).
 */
export class MarketingToolClient {
  readonly name = 'marketing-tool-client';

  private readonly gateway: AgentPlatformGateway;
  private readonly toolManager: ToolManagerService;

  constructor(options: MarketingToolClientOptions) {
    this.gateway = options.gateway;
    this.toolManager = options.toolManager;
  }

  /** Pre-flight authorization check (fail-closed). */
  canUse(agentId: string, toolName: string, namespaces: readonly string[]): boolean {
    if (!this.gateway.isPlatformManaged(agentId)) {
      return false;
    }
    if (!this.gateway.isToolAllowed(agentId, toolName)) {
      return false;
    }
    if (!this.toolManager.exists(toolName)) {
      return false;
    }
    return namespaces.length > 0;
  }

  /**
   * Executes a tool through AG-004 for a marketing agent. Throws
   * {@link MarketingAIError} only for authorization failures (before any tool
   * I/O); tool-level failures are returned as a typed outcome.
   */
  async execute(input: {
    readonly agentId: string;
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly actor: ToolActor;
    readonly namespace: string;
    readonly requestId?: string;
    readonly traceId?: string;
    readonly correlationId?: string;
    readonly timeoutMs?: number;
  }): Promise<MarketingToolOutcome> {
    const { agentId, toolName, namespace } = input;
    if (!this.canUse(agentId, toolName, [namespace])) {
      throw new MarketingAIError(
        MARKETING_AI_ERROR_CODES.AGENT_REJECTED,
        `Tool '${toolName}' is not authorized for agent ${agentId} in namespace '${namespace}'`,
      );
    }
    const context: ToolExecutionContext = {
      actor: input.actor,
      requestId: input.requestId,
      traceId: input.traceId,
      correlationId: input.correlationId,
      namespace,
      agentId,
      timeoutMs: input.timeoutMs,
    };
    const result: ToolResult = await this.toolManager.execute(toolName, input.toolInput, context);
    return {
      success: result.status === ToolResultStatus.Success,
      toolId: result.toolId,
      toolName: result.toolName,
      status: result.status,
      output: result.output === undefined ? undefined : safeMarketingValue(result.output),
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
    };
  }
}

/** A marketing-agentic operation runnable through the Sprint 18 loop. */
export interface MarketingAgenticTask {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly userInput: string;
  readonly context: MarketingContext;
  readonly allowedTools?: readonly string[];
  readonly requestId?: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Normalized, safe outcome of a marketing-agentic run. */
export interface MarketingAgenticOutcome {
  readonly agentId: string;
  readonly status: AgenticLoopResult['status'];
  readonly finalResponse?: string;
  readonly clarification?: string;
  readonly toolCallCount: number;
  readonly toolSuccessCount: number;
  readonly rejections: number;
  readonly durationMs: number;
  readonly usage: { readonly reasoningCalls: number; readonly totalTokens: number };
  readonly errorCode?: string;
  readonly provider?: string;
  readonly model?: string;
}

/** Creates a Marketing-group tool actor for marketing-team tool calls. */
export function marketingToolActor(
  agentId: string,
  actor: { readonly actorId: string; readonly namespaces: readonly string[] },
): ToolActor {
  void agentId;
  return {
    group: ToolActorGroup.Marketing,
    id: actor.actorId,
    namespaces: actor.namespaces.length > 0 ? actor.namespaces : ['default'],
  };
}

/** Converts bounded marketing context into the reasoning context item shape. */
export function toMarketingReasoningContext(
  context: MarketingContext,
  kind: 'memory' | 'knowledge',
): readonly ReasoningContextItem[] {
  const sources = kind === 'memory' ? context.memory : context.knowledge;
  return sources.map((item) => ({
    id: item.id,
    source: item.source,
    content: item.content,
    namespace: item.namespace,
  }));
}

/**
 * Runs one marketing-agentic task through the Sprint 18 agentic loop. This
 * is the optional, LLM-gated path: it is only reached when the composition
 * enables agentic mode with a working reasoning stack.
 */
export async function runMarketingAgenticTask(options: {
  readonly loop: AgenticLoopService;
  readonly task: MarketingAgenticTask;
  readonly actor: ToolActor;
  readonly namespace: string;
}): Promise<MarketingAgenticOutcome> {
  const { loop, task, actor, namespace } = options;
  if (task.allowedTools !== undefined && task.allowedTools.length === 0) {
    throw new MarketingAIError(
      MARKETING_AI_ERROR_CODES.AGENT_REJECTED,
      'Agentic task requested with an empty tool allowlist',
    );
  }
  const result = await loop.run({
    userInput: task.userInput,
    context: {
      capability: task.capabilityId,
      agentId: task.agentId,
    },
    memoryContext: toMarketingReasoningContext(task.context, 'memory'),
    knowledgeContext: toMarketingReasoningContext(task.context, 'knowledge'),
    actor,
    namespace,
    agentId: task.agentId,
    requestId: task.requestId,
    traceId: task.traceId,
    correlationId: task.correlationId,
    timeoutMs: task.timeoutMs,
    signal: task.signal,
    allowedTools: task.allowedTools,
  });
  return {
    agentId: task.agentId,
    status: result.status,
    finalResponse: result.finalResponse,
    clarification: result.clarification,
    toolCallCount: result.toolCalls.length,
    toolSuccessCount: result.toolCalls.filter((call) => call.status === 'SUCCEEDED').length,
    rejections: result.rejections.length,
    durationMs: result.durationMs,
    usage: {
      reasoningCalls: result.usage.reasoningCalls,
      totalTokens: result.usage.totalTokens,
    },
    errorCode: result.errorCode,
    provider: result.provider,
    model: result.model,
  };
}
