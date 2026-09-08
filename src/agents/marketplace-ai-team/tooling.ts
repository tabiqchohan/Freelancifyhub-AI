/**
 * Sprint 23 — Marketplace AI Team v1. Tool + agentic integration.
 *
 * Tools are executed strictly through AG-004 with the platform gateway's
 * allowlist enforced (never bypassed). Agentic reasoning, when enabled at the
 * composition level, runs through the Sprint 18 agentic loop with AG-004 tools
 * and the authorized marketplace tool actor. Both paths fail closed: an
 * unauthorized tool is denied before any execution and never leaks internals.
 * v1 marketplace agents ship with an empty allowlist, so every path below
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
import { MarketplaceAIError, MARKETPLACE_AI_ERROR_CODES } from './errors.js';
import { safeMarketplaceValue } from './security.js';
import type { MarketplaceContext } from './types.js';

/** Normalized, safe outcome of one marketplace tool call. */
export interface MarketplaceToolOutcome {
  readonly success: boolean;
  readonly toolId: string;
  readonly toolName: string;
  readonly status: ToolResultStatus;
  readonly output?: unknown;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly durationMs: number;
}

/** Options for the marketplace tool client. */
export interface MarketplaceToolClientOptions {
  readonly gateway: AgentPlatformGateway;
  readonly toolManager: ToolManagerService;
}

/**
 * Authorized AG-004 marketplace tool adapter. Enforces the platform tool
 * allowlist and always runs with a Marketplace-group actor (never with
 * escalated scope).
 */
export class MarketplaceToolClient {
  readonly name = 'marketplace-tool-client';

  private readonly gateway: AgentPlatformGateway;
  private readonly toolManager: ToolManagerService;

  constructor(options: MarketplaceToolClientOptions) {
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
   * Executes a tool through AG-004 for a marketplace agent. Throws
   * {@link MarketplaceAIError} only for authorization failures (before any tool
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
  }): Promise<MarketplaceToolOutcome> {
    const { agentId, toolName, namespace } = input;
    if (!this.canUse(agentId, toolName, [namespace])) {
      throw new MarketplaceAIError(
        MARKETPLACE_AI_ERROR_CODES.AGENT_REJECTED,
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
      output: result.output === undefined ? undefined : safeMarketplaceValue(result.output),
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
    };
  }
}

/** A marketplace-agentic operation runnable through the Sprint 18 loop. */
export interface MarketplaceAgenticTask {
  readonly agentId: string;
  readonly capabilityId: string;
  readonly userInput: string;
  readonly context: MarketplaceContext;
  readonly allowedTools?: readonly string[];
  readonly requestId?: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Normalized, safe outcome of a marketplace-agentic run. */
export interface MarketplaceAgenticOutcome {
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

/** Creates a Marketplace-group tool actor for marketplace-team tool calls. */
export function marketplaceToolActor(
  agentId: string,
  actor: { readonly actorId: string; readonly namespaces: readonly string[] },
): ToolActor {
  void agentId;
  return {
    group: ToolActorGroup.Marketplace,
    id: actor.actorId,
    namespaces: actor.namespaces.length > 0 ? actor.namespaces : ['default'],
  };
}

/** Converts bounded marketplace context into the reasoning context item shape. */
export function toMarketplaceReasoningContext(
  context: MarketplaceContext,
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
 * Runs one marketplace-agentic task through the Sprint 18 agentic loop. This
 * is the optional, LLM-gated path: it is only reached when the composition
 * enables agentic mode with a working reasoning stack.
 */
export async function runMarketplaceAgenticTask(options: {
  readonly loop: AgenticLoopService;
  readonly task: MarketplaceAgenticTask;
  readonly actor: ToolActor;
  readonly namespace: string;
}): Promise<MarketplaceAgenticOutcome> {
  const { loop, task, actor, namespace } = options;
  if (task.allowedTools !== undefined && task.allowedTools.length === 0) {
    throw new MarketplaceAIError(
      MARKETPLACE_AI_ERROR_CODES.AGENT_REJECTED,
      'Agentic task requested with an empty tool allowlist',
    );
  }
  const result = await loop.run({
    userInput: task.userInput,
    context: {
      capability: task.capabilityId,
      agentId: task.agentId,
    },
    memoryContext: toMarketplaceReasoningContext(task.context, 'memory'),
    knowledgeContext: toMarketplaceReasoningContext(task.context, 'knowledge'),
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
