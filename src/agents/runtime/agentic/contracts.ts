/**
 * Sprint 18 — Agentic Tool-Calling & Reasoning Loop. Domain contracts.
 *
 * These are the *runtime* contracts of the agentic loop: the records the loop
 * builds around validated model decisions and AG-004 tool results. They never
 * carry raw chain-of-thought, private reasoning, prompts, secrets, or stack
 * traces — only safe identifiers, counts, statuses, and bounded metadata.
 */

import type { IsoTimestamp, TraceId } from '../../ag-001-master-orchestrator/types/index.js';
import type { ToolActor, ToolResultStatus } from '../../ag-004-tool-manager/index.js';
import type { LLMJsonValue, ReasoningContextItem, ToolDecisionType } from '../../../llm/index.js';

/** Re-exported AG-004 actor type (the loop always uses the public abstraction). */
export type { ToolActor };

/**
 * Lifecycle states of a single agentic loop session. Transitions are enforced
 * deterministically by the {@link AgenticLoopStateMachine}; friendly string
 * booleans are never used to manage this lifecycle.
 */
export enum AgenticLoopState {
  Idle = 'IDLE',
  Reasoning = 'REASONING',
  ToolValidating = 'TOOL_VALIDATING',
  ToolExecuting = 'TOOL_EXECUTING',
  ToolResultProcessing = 'TOOL_RESULT_PROCESSING',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
  Cancelled = 'CANCELLED',
  TimedOut = 'TIMED_OUT',
  LimitReached = 'LIMIT_REACHED',
  Clarification = 'CLARIFICATION',
}

/** Terminal status of a completed agentic run. */
export enum AgenticLoopStatus {
  Completed = 'COMPLETED',
  Clarification = 'CLARIFICATION',
  Aborted = 'ABORTED',
  Cancelled = 'CANCELLED',
  TimedOut = 'TIMED_OUT',
  Failed = 'FAILED',
  LimitReached = 'LIMIT_REACHED',
}

/** Lifecycle of a single model→tool→result turn within the loop. */
export interface AgenticTurn {
  readonly turnId: string;
  readonly index: number;
  readonly state: AgenticLoopState;
  readonly decisionType: ToolDecisionType;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  /** Safe normalized latency of the reasoning call (ms). */
  readonly reasoningLatencyMs?: number;
  readonly toolCall?: ToolCallRequest;
  readonly toolOutcome?: ToolCallOutcome;
  readonly decisionErrorCode?: string;
}

/** A loop-validated tool call the loop intends to execute through AG-004. */
export interface ToolCallRequest {
  readonly callId: string;
  readonly turnId: string;
  readonly correlationId?: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, LLMJsonValue>>;
}

/** A model-proposed tool call (parsed; ids are attached by the loop). */
export interface ToolCall {
  readonly tool: string;
  readonly arguments: ToolCallArguments;
}

/** Structured arguments for a tool call. */
export type ToolCallArguments = Readonly<Record<string, LLMJsonValue>>;

/** Safe normalized result of a tool call (never contains raw tool output). */
export interface ToolCallResult {
  readonly callId: string;
  readonly turnId: string;
  readonly tool: string;
  readonly status: ToolCallStatus;
  readonly error?: ToolCallError;
  readonly durationMs?: number;
}

/** Bound normalized error attached to a failed tool call. */
export interface ToolCallError {
  readonly code: string;
  readonly retryable: boolean;
}

/** Typed outcome of a single tool call after AG-004 execution. */
export enum ToolCallStatus {
  Succeeded = 'SUCCEEDED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Safe record of a tool call outcome (no raw outputs, no stack traces). */
export interface ToolCallOutcome {
  readonly callId: string;
  readonly turnId: string;
  readonly tool: string;
  readonly status: ToolCallStatus;
  /** The underlying AG-004 {@link ToolResultStatus}. */
  readonly resultStatus: ToolResultStatus;
  readonly errorCode?: string;
  readonly durationMs?: number;
}

/** Aggregated, safe usage/cost-control counters for one agentic operation. */
export interface AgenticUsage {
  readonly reasoningCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** A normalized, safe rejection produced before any tool execution. */
export interface AgenticToolRejection {
  readonly callId: string;
  readonly tool: string;
  readonly code: string;
  readonly message: string;
}

/** Input for running one bounded agentic operation. */
export interface AgenticLoopRunInput {
  /** The primary user request text (already extracted upstream). */
  readonly userInput: string;
  /** Optional structural request context (JSON-safe, sanitized). */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Already access-controlled memory context (AG-002). */
  readonly memoryContext?: readonly ReasoningContextItem[];
  /** Already access-controlled knowledge context (AG-003). */
  readonly knowledgeContext?: readonly ReasoningContextItem[];
  /** The AG-004 actor the loop executes tools as (must hold Execute). */
  readonly actor: ToolActor;
  /** Default tool namespace when the actor does not pin one. */
  readonly namespace?: string;
  readonly agentId?: string;
  readonly executionId?: string;
  readonly requestId?: string;
  readonly traceId?: TraceId;
  readonly correlationId?: string;
  /** Cooperative cancellation propagated to reasoning + tool execution. */
  readonly signal?: AbortSignal;
  /** Overall deadline for the whole operation (ms); falls back to config. */
  readonly timeoutMs?: number;
}

/** The final result of a bounded agentic loop session. */
export interface AgenticLoopResult {
  readonly status: AgenticLoopStatus;
  readonly completedAt: IsoTimestamp;
  readonly durationMs: number;
  readonly turns: number;
  readonly reasoningCalls: number;
  readonly toolCalls: readonly ToolCallOutcome[];
  readonly rejections: readonly AgenticToolRejection[];
  /** Final answer text (Completed only). */
  readonly finalResponse?: string;
  /** Clarification question (Clarification only). */
  readonly clarification?: string;
  /** Safe normalized error code for failed/limited runs. */
  readonly errorCode?: string;
  /** Safe error message (never internal details or secrets). */
  readonly errorMessage?: string;
  readonly retryable?: boolean;
  readonly usage: AgenticUsage;
  /** Safe reasoning identity of the last reasoning call. */
  readonly provider?: string;
  readonly model?: string;
  readonly traceId?: string;
  readonly correlationId?: string;
}
