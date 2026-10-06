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

import { DEFAULT_LLM_MAX_RESPONSE_BYTES } from '../config/schema.js';
import type { LLMConfig } from '../config/schema.js';
import {
  LLMAuthenticationError,
  LLMCancelledError,
  LLMConfigurationError,
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
  readonly config: Pick<
    LLMConfig,
    'LLM_BASE_URL' | 'LLM_API_KEY' | 'LLM_MODEL' | 'LLM_TIMEOUT_MS' | 'LLM_MAX_RESPONSE_BYTES'
  >;
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
  private readonly maxResponseBytes: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpLLMProviderOptions) {
    this.model = options.config.LLM_MODEL;
    this.baseUrl = options.config.LLM_BASE_URL.replace(/\/+$/, '');
    this.apiKey = options.config.LLM_API_KEY;
    this.defaultTimeoutMs = options.config.LLM_TIMEOUT_MS;
    this.maxResponseBytes = options.config.LLM_MAX_RESPONSE_BYTES ?? DEFAULT_LLM_MAX_RESPONSE_BYTES;
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
      // Prompts15 Phase 14: release the socket instead of leaving the body
      // unread, otherwise sustained upstream errors pile up keep-alive
      // connections the pool can never reuse.
      await response.body?.cancel().catch(() => undefined);
      throw this.mapHttpError(response);
    }

    let payload: unknown;
    try {
      payload = await this.readBoundedJson(response);
    } catch (error) {
      if (error instanceof LLMResponseValidationError) {
        throw error;
      }
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
    // Prompts15 Phase 14: this previously returned '' for a blank key, so a
    // provider constructed outside parseLlmConfig() sent unauthenticated traffic
    // and surfaced a confusing non-retryable 401 instead of failing closed.
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) {
      throw new LLMConfigurationError(
        'The http LLM provider requires a non-empty LLM_API_KEY. Refusing to send an unauthenticated request.',
      );
    }
    return `Bearer ${this.apiKey}`;
  }

  /**
   * Prompts15 Phase 14 — `statusText` is the upstream server's own reason phrase
   * and was interpolated straight into an Error.message, which any generic
   * `logger.error({ error })` prints. That is a log-injection channel, so it is
   * clamped to a short, printable-character allowlist.
   */
  private safeStatusText(response: Response): string {
    const cleaned = response.statusText
      .replace(/[^\x20-\x7e]/g, '')
      .slice(0, 64)
      .trim();
    return cleaned.length === 0 ? '' : cleaned;
  }

  /**
   * Prompts15 Phase 14 — buffers at most `LLM_MAX_RESPONSE_BYTES`.
   *
   * `response.json()` used to materialise the entire body before any validation
   * ran, so a misconfigured or hostile `LLM_BASE_URL` could exhaust memory. The
   * downstream length checks only ran on the already-allocated string.
   *
   * `content-length` is treated as a hint, not a guarantee (it may be absent or
   * wrong), so the streaming reader enforces the real budget.
   */
  private async readBoundedJson(response: Response): Promise<unknown> {
    const limit = this.maxResponseBytes;

    // Defensive: `headers` is absent on a hand-rolled Response in tests, and the
    // budget is enforced by the reader below regardless.
    const declared = response.headers?.get('content-length') ?? null;
    if (declared !== null) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > limit) {
        await response.body?.cancel().catch(() => undefined);
        throw new LLMResponseValidationError(
          `LLM provider response declared ${size} bytes, exceeding the ${limit} byte limit`,
          { details: { maxResponseBytes: limit } },
        );
      }
    }

    // A hand-rolled Response (tests, or a fetch polyfill) may expose no stream.
    // Fall back to the standard path; the content-length check above still ran.
    const body: ReadableStream<Uint8Array> | null | undefined = response.body;
    if (body === null || body === undefined || typeof body.getReader !== 'function') {
      return response.json();
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value === undefined) {
          continue;
        }
        received += value.byteLength;
        if (received > limit) {
          throw new LLMResponseValidationError(
            `LLM provider response exceeded the ${limit} byte limit`,
            { details: { maxResponseBytes: limit } },
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof LLMResponseValidationError) {
        throw error;
      }
      throw error;
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(merged)) as unknown;
  }

  /**
   * The endpoint with any userinfo and query string removed.
   *
   * `LLM_BASE_URL` is now schema-validated to reject credentials and query
   * strings, but the endpoint is still logged on every 5xx, so it is scrubbed at
   * the point of use rather than relying on validation alone.
   */
  private safeEndpoint(): string {
    try {
      const parsed = new URL(this.baseUrl);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
      return '[unparsable base url]';
    }
  }

  private mapHttpError(response: Response): Error {
    const status = response.status;
    const statusText = this.safeStatusText(response);

    switch (status) {
      case 401:
      case 403:
        return new LLMAuthenticationError(`LLM provider rejected the credentials (${status})`, {
          details: { status, endpoint: this.safeEndpoint() },
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
          return new LLMProviderError(`LLM provider failed on ${this.safeEndpoint()} (${status})`, {
            details: { status, endpoint: this.safeEndpoint() },
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
  config: Pick<
    LLMConfig,
    'LLM_BASE_URL' | 'LLM_API_KEY' | 'LLM_MODEL' | 'LLM_TIMEOUT_MS' | 'LLM_MAX_RESPONSE_BYTES'
  >,
  fetchFn?: typeof fetch,
): HttpLLMProvider {
  return new HttpLLMProvider({ config, fetchFn });
}
