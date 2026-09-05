/**
 * Sprint 17 — AI reasoning service.
 *
 * A capability, not an orchestrator: builds and bounds prompts from structured
 * input, drives a provider with timeout + classification-aware retries, and
 * records safe events and metrics. Coordinates with the rest of the system
 * only through its interfaces — it never routes, plans, or touches storage.
 * Fails closed: disabled configurations reject reasoning immediately.
 */

import type { LLMConfig } from '../config/schema.js';
import { DEFAULT_LLM_BACKOFF_BASE_MS, DEFAULT_LLM_BACKOFF_MAX_MS } from '../constants.js';
import {
  LLMConfigurationError,
  LLMInvalidRequestError,
  LLMError,
  classifyLLMError,
} from '../errors/index.js';
import {
  LLMEventLog,
  failedEvent,
  retryEvent,
  startedEvent,
  succeededEvent,
} from '../events/index.js';
import { LLMMetrics } from '../metrics/index.js';
import { generateWithRetry, type GenerateWithRetryOptions } from '../retry/index.js';
import { buildReasoningMessages } from '../security/index.js';
import type {
  AIReasoningServiceContract,
  LLMProvider,
  LLMProviderStatus,
  LLMRequestOptions,
  ReasoningRequest,
  ReasoningResult,
} from '../types/index.js';

/** Stable identity of the AI reasoning capability. */
export const AI_REASONING_SERVICE_ID = 'ai-reasoning-service';

/** Options for constructing the reasoning service. */
export interface AIReasoningServiceOptions {
  readonly provider: LLMProvider;
  readonly config: Pick<
    LLMConfig,
    | 'LLM_ENABLED'
    | 'LLM_MODEL'
    | 'LLM_TIMEOUT_MS'
    | 'LLM_MAX_RETRIES'
    | 'LLM_MAX_CONTEXT_BYTES'
    | 'LLM_TEMPERATURE'
    | 'LLM_MAX_OUTPUT_TOKENS'
  >;
  readonly eventLog?: LLMEventLog;
  readonly metrics?: LLMMetrics;
  /** Injectable sleep for deterministic retry tests (default: cancellable delay). */
  readonly retrySleep?: GenerateWithRetryOptions['sleep'];
  readonly defaultBackoffBaseMs?: number;
  readonly defaultBackoffMaxMs?: number;
}

/**
 * Provider-independent AI reasoning capability. Never touches AG-001 routing,
 * AG-002 storage, AG-003 knowledge stores, or AG-004 tool execution directly.
 */
export class AIReasoningService implements AIReasoningServiceContract {
  readonly id = AI_REASONING_SERVICE_ID;

  private readonly provider: LLMProvider;
  private readonly config: AIReasoningServiceOptions['config'];
  private readonly eventLog: LLMEventLog;
  private readonly metrics: LLMMetrics;
  private readonly retrySleep: GenerateWithRetryOptions['sleep'];
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(options: AIReasoningServiceOptions) {
    this.provider = options.provider;
    this.config = options.config;
    this.eventLog = options.eventLog ?? new LLMEventLog();
    this.metrics = options.metrics ?? new LLMMetrics();
    this.retrySleep = options.retrySleep;
    this.backoffBaseMs = options.defaultBackoffBaseMs ?? DEFAULT_LLM_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.defaultBackoffMaxMs ?? DEFAULT_LLM_BACKOFF_MAX_MS;
  }

  isEnabled(): boolean {
    return this.config.LLM_ENABLED;
  }

  providerInfo(): LLMProviderStatus {
    return {
      enabled: this.config.LLM_ENABLED,
      configured: this.config.LLM_ENABLED,
      provider: this.config.LLM_ENABLED ? this.provider.id : 'disabled',
      model: this.config.LLM_ENABLED ? this.provider.model : '',
    };
  }

  async reason(
    request: ReasoningRequest,
    options: LLMRequestOptions = {},
  ): Promise<ReasoningResult> {
    if (!this.config.LLM_ENABLED) {
      throw new LLMConfigurationError('LLM reasoning is disabled by configuration', {
        code: 'REASONING_UNAVAILABLE',
      });
    }

    const correlationId = request.correlationId ?? options.requestId;
    const traceId = correlationId;
    const startedAt = new Date().toISOString();
    const started = Date.now();

    this.eventLog.append(
      startedEvent({
        traceId,
        correlationId,
        provider: this.provider.id,
        model: this.provider.model,
        occurredAt: startedAt,
      }),
    );

    let retries = 0;

    try {
      if (typeof request.userInput !== 'string' || request.userInput.trim().length === 0) {
        throw new LLMInvalidRequestError('Reasoning requires non-empty user input');
      }

      const bounded = buildReasoningMessages(request, this.config);

      const response = await generateWithRetry(
        () =>
          this.provider.generate(
            {
              messages: bounded.messages,
              model: request.model,
              temperature: request.temperature ?? this.config.LLM_TEMPERATURE,
              maxOutputTokens: request.maxOutputTokens ?? this.config.LLM_MAX_OUTPUT_TOKENS,
              metadata: {
                reasoningId: correlationId ?? 'anonymous',
                traceId: traceId ?? 'anonymous',
              },
            },
            {
              signal: options.signal,
              timeoutMs: options.timeoutMs,
              requestId: correlationId,
              maxRetries: options.maxRetries,
            },
          ),
        {
          retries: {
            maxRetries: options.maxRetries ?? this.config.LLM_MAX_RETRIES,
            backoffBaseMs: this.backoffBaseMs,
            backoffMaxMs: this.backoffMaxMs,
          },
          timeoutMs: options.timeoutMs ?? this.config.LLM_TIMEOUT_MS,
          signal: options.signal,
          sleep: this.retrySleep,
          onRetry: (info) => {
            retries += 1;
            const classification = classifyLLMError(info.error);
            this.eventLog.append(
              retryEvent({
                traceId,
                correlationId,
                provider: this.provider.id,
                model: this.provider.model,
                occurredAt: new Date().toISOString(),
                attempt: info.attempt,
                delayMs: info.delayMs,
                errorClass: classification.errorClass,
                errorCode: info.error instanceof LLMError ? info.error.code : undefined,
              }),
            );
          },
        },
      );

      const durationMs = Date.now() - started;
      this.metrics.record({
        providerId: this.provider.id,
        model: this.provider.model,
        outcome: 'success',
        durationMs,
        retries,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      });
      this.eventLog.append(
        succeededEvent({
          traceId,
          correlationId,
          provider: this.provider.id,
          model: this.provider.model,
          occurredAt: new Date().toISOString(),
          durationMs,
          attempts: response.attempts,
          usage: response.usage,
          finishReason: response.finishReason,
        }),
      );

      return {
        output: response.text,
        provider: response.provider,
        model: response.model,
        usage: response.usage,
        finishReason: response.finishReason,
        latencyMs: durationMs,
        correlationId,
        requestId: response.requestId,
        attempts: response.attempts,
      };
    } catch (error) {
      const classification = classifyLLMError(error);
      const durationMs = Date.now() - started;

      this.metrics.record({
        providerId: this.provider.id,
        model: this.provider.model,
        outcome: classificationToOutcome(classification.errorClass),
        durationMs,
        retries,
      });
      this.eventLog.append(
        failedEvent({
          traceId,
          correlationId,
          provider: this.provider.id,
          model: this.provider.model,
          occurredAt: new Date().toISOString(),
          durationMs,
          retryCount: retries,
          errorClass: classification.errorClass,
          errorCode: error instanceof LLMError ? error.code : undefined,
        }),
      );

      throw error as LLMError;
    }
  }
}

function classificationToOutcome(
  class_: string,
):
  | 'success'
  | 'timeout'
  | 'cancelled'
  | 'rate_limit'
  | 'validation_failure'
  | 'auth_failure'
  | 'failure' {
  switch (class_) {
    case 'timeout':
      return 'timeout';
    case 'cancelled':
      return 'cancelled';
    case 'rate_limit':
      return 'rate_limit';
    case 'response_validation':
    case 'invalid_request':
      return 'validation_failure';
    case 'authentication':
      return 'auth_failure';
    default:
      return 'failure';
  }
}

/** Convenience: builds a default-configured reasoning service. */
export function createAIReasoningService(options: AIReasoningServiceOptions): AIReasoningService {
  return new AIReasoningService(options);
}
