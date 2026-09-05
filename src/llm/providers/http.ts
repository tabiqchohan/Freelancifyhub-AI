/**
 * Sprint 17 — Minimal OpenAI-compatible HTTP LLM provider.
 *
 * Uses the platform `fetch` (no SDK) against `POST {baseUrl}/chat/completions`
 * with an Authorization Bearer header. Responses are validated with zod; every
 * failure is normalized into the {@link LLMError} hierarchy. The API key,
 * request payload, and raw response body are NEVER logged or included in
 * error messages.
 *
 * This provider performs exactly one attempt per `generate` call; retries and
 * timeouts are orchestrated by the reasoning service via `generateWithRetry`.
 */

import { z } from 'zod';

import type { LLMConfig } from '../config/schema.js';
import {
  LLMAuthenticationError,
  LLMCancelledError,
  LLMInvalidRequestError,
  LLMNetworkError,
  LLMProviderError,
  LLMRateLimitError,
  LLMResponseValidationError,
  LLMTimeoutError,
} from '../errors/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMRequestOptions,
  LLMResponse,
  LLMUsage,
} from '../types/index.js';

/** OpenAI-compatible chat-completions response (minimal subset). */
const ChatCompletionResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ role: z.string().optional(), content: z.string() }),
        finish_reason: z.string().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

/** Options for the HTTP provider. */
export interface HttpLLMProviderOptions {
  readonly config: Pick<LLMConfig, 'LLM_BASE_URL' | 'LLM_API_KEY' | 'LLM_MODEL' | 'LLM_TIMEOUT_MS'>;
  /** Injectable fetch for tests (defaults to globalThis.fetch). */
  readonly fetchFn?: typeof fetch;
}

/** Minimal OpenAI-compatible HTTP chat-completions provider. */
export class HttpLLMProvider implements LLMProvider {
  readonly id = 'http';
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpLLMProviderOptions) {
    this.model = options.config.LLM_MODEL;
    this.baseUrl = options.config.LLM_BASE_URL.replace(/\/+$/, '');
    this.apiKey = options.config.LLM_API_KEY;
    this.defaultTimeoutMs = options.config.LLM_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async generate(request: LLMRequest, options: LLMRequestOptions = {}): Promise<LLMResponse> {
    const effectiveTimeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const endpoint = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: this.authorizationHeader(),
    };

    const body = {
      model: request.model ?? this.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
    };

    // Per-attempt abort that combines external cancellation with a timeout so
    // the connection is actually torn down (never left dangling after a guard
    // timeout abandons the fetch).
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeoutMs);
    const onExternalAbort = (): void => controller.abort();

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new LLMCancelledError('LLM request cancelled before transmission');
      }
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new LLMTimeoutError(`LLM request exceeded ${effectiveTimeoutMs}ms timeout`, {
          details: { timeoutMs: effectiveTimeoutMs },
          cause: error,
        });
      }
      if (controller.signal.aborted || options.signal?.aborted === true) {
        throw new LLMCancelledError('LLM request cancelled', { cause: error });
      }
      throw new LLMNetworkError('LLM request failed at the transport layer', { cause: error });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }

    if (!response.ok) {
      throw this.mapHttpError(response, endpoint);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new LLMResponseValidationError('LLM provider returned a non-JSON response', {
        cause: error,
      });
    }

    const parsed = ChatCompletionResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new LLMResponseValidationError('LLM provider response failed validation', {
        cause: parsed.error,
      });
    }

    const choice = parsed.data.choices[0]!;
    const usage = mapUsage(parsed.data.usage);

    return {
      text: choice.message.content,
      provider: this.id,
      model: parsed.data.model ?? this.model,
      requestId: parsed.data.id,
      finishReason: choice.finish_reason,
      usage,
      attempts: 1,
    };
  }

  private authorizationHeader(): string {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) {
      return '';
    }
    return `Bearer ${this.apiKey}`;
  }

  private mapHttpError(response: Response, endpoint: string): Error {
    const status = response.status;
    const statusText = response.statusText;

    switch (status) {
      case 401:
      case 403:
        return new LLMAuthenticationError(`LLM provider rejected the credentials (${status})`, {
          details: { status, endpoint },
        });
      case 429:
        return new LLMRateLimitError(`LLM provider rate-limited the request (${status})`, {
          details: { status },
        });
      case 400:
      case 404:
      case 422:
        return new LLMInvalidRequestError(
          `LLM provider rejected the request (${status}: ${statusText})`,
          { details: { status } },
        );
      default:
        if (status >= 500) {
          return new LLMProviderError(`LLM provider failed on ${endpoint} (${status})`, {
            details: { status },
          });
        }
        return new LLMProviderError(`LLM provider returned an unexpected status (${status})`, {
          details: { status },
        });
    }
  }
}

function mapUsage(
  raw: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
): LLMUsage | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return {
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens,
    totalTokens: raw.total_tokens,
  };
}

/** Convenience: builds an HTTP provider from an LLM config slice. */
export function createHttpProvider(
  config: Pick<LLMConfig, 'LLM_BASE_URL' | 'LLM_API_KEY' | 'LLM_MODEL' | 'LLM_TIMEOUT_MS'>,
  fetchFn?: typeof fetch,
): HttpLLMProvider {
  return new HttpLLMProvider({ config, fetchFn });
}
