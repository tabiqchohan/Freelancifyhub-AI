/**
 * Sprint 17 — LLM Provider & AI Reasoning domain contracts.
 *
 * Provider-agnostic by design: no SDK types are ever exposed here. The core
 * system depends on {@link LLMProvider}; concrete SDK/HTTP implementations live
 * behind this interface in `providers/`. Usage fields are optional because not
 * every provider reports them.
 */

/** A single chat message role (minimum supported set). */
export type LLMRole = 'system' | 'user' | 'assistant';

/** A single chat message handed to a provider. */
export interface LLMMessage {
  readonly role: LLMRole;
  readonly content: string;
}

/** Token usage reported by a provider (nullable/optional when unavailable). */
export interface LLMUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/** Normalized finish reason, when the provider reports one. */
export type LLMFinishReason = string;

/** Metadata attached to a single LLM request (never persisted raw). */
export type LLMMetadata = Readonly<Record<string, string | number | boolean>>;

/** A provider request: messages plus optional sampling overrides. */
export interface LLMRequest {
  readonly messages: readonly LLMMessage[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly metadata?: LLMMetadata;
}

/** Options accepted alongside a single generation call. */
export interface LLMRequestOptions {
  /** Cooperative cancellation token. */
  readonly signal?: AbortSignal;
  /** Per-request timeout; falls back to provider configuration. */
  readonly timeoutMs?: number;
  /** Caller correlation/request id (safe metadata only). */
  readonly requestId?: string;
  /** Retry budget; falls back to provider configuration. */
  readonly maxRetries?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
}

/** A normalized provider response. */
export interface LLMResponse {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly usage?: LLMUsage;
  readonly finishReason?: LLMFinishReason;
  /** Provider request id when available (safe identifier only). */
  readonly requestId?: string;
  /** Retry attempts performed before the successful call (0 when none). */
  readonly attempts?: number;
}

/**
 * The provider-agnostic LLM abstraction. Never exposes SDK types; callers must
 * be able to depend solely on this interface.
 */
export interface LLMProvider {
  /** Stable provider identity (e.g. `mock`, `http`). */
  readonly id: string;
  /** The model identity the provider is configured for. */
  readonly model: string;
  /**
   * Generates a completion. Throws a normalized {@link LLMError} on failure.
   * Respects {@link LLMRequestOptions.signal} and timeout.
   */
  generate(request: LLMRequest, options?: LLMRequestOptions): Promise<LLMResponse>;
}

/** Safe provider status surfaced to health/readiness (never keys/secrets). */
export interface LLMProviderStatus {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly provider: string;
  readonly model: string;
}

/**
 * A single chunk of validated upstream context the reasoning layer may include.
 * Content is expected to already be access-controlled by the owning subsystem
 * (AG-002 memory / AG-003 knowledge); the reasoning layer never queries those
 * stores directly and always re-sanitizes before sending.
 */
export interface ReasoningContextItem {
  readonly id: string;
  readonly source: string;
  readonly content: string;
  readonly securityLevel?: string;
  readonly namespace?: string;
}

/** A sanitized tool result eligible for inclusion in a reasoning request. */
export interface ReasoningToolResult {
  readonly toolId: string;
  readonly toolName?: string;
  readonly status: string;
  readonly output?: unknown;
}

/** Structured reasoning input. Supports bounded memory/knowledge/tool context. */
export interface ReasoningRequest {
  /** System-level instruction (kept structurally separate from user content). */
  readonly systemInstruction?: string;
  /** The primary user request text (required). */
  readonly userInput: string;
  /** Optional request/execution context (JSON-safe, sanitized upstream). */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Access-controlled memory context produced by the orchestration layer. */
  readonly memoryContext?: readonly ReasoningContextItem[];
  /** Access-controlled knowledge context produced by the orchestration layer. */
  readonly knowledgeContext?: readonly ReasoningContextItem[];
  /** Sanitized tool results produced through AG-004. */
  readonly toolResults?: readonly ReasoningToolResult[];
  /** Correlation id propagated through events/metrics (safe metadata). */
  readonly correlationId?: string;
  /** Optional per-request model override. */
  readonly model?: string;
  /** Optional per-request temperature override. */
  readonly temperature?: number;
  /** Optional per-request max output tokens override. */
  readonly maxOutputTokens?: number;
}

/** The structured outcome of a reasoning call. */
export interface ReasoningResult {
  readonly output: string;
  readonly provider: string;
  readonly model: string;
  readonly usage?: LLMUsage;
  readonly finishReason?: LLMFinishReason;
  /** Round-trip latency of the generation call. */
  readonly latencyMs: number;
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly attempts?: number;
}

/**
 * Provider-independent AI reasoning capability. A *capability*, not an
 * orchestrator: it never routes, plans, or accesses databases directly.
 */
export interface AIReasoningServiceContract {
  readonly id: string;
  /** Whether reasoning is enabled by configuration. */
  isEnabled(): boolean;
  /** Safe provider identity (never credentials). */
  providerInfo(): LLMProviderStatus;
  /**
   * Runs a reasoning call. Throws a normalized {@link LLMError} on failure,
   * including {@link LLMConfigurationError} when reasoning is disabled.
   */
  reason(request: ReasoningRequest, options?: LLMRequestOptions): Promise<ReasoningResult>;
}
