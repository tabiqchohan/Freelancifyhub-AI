import { describe, it, expect } from 'vitest';

import { LLMConfigSchema, DEFAULT_LLM_MAX_RESPONSE_BYTES } from '../../../src/llm/config/schema.js';
import { HttpLLMProvider } from '../../../src/llm/providers/http.js';
import {
  LLMConfigurationError,
  LLMResponseValidationError,
} from '../../../src/llm/errors/index.js';

/**
 * Prompts15 Phase 14.
 *
 * These are the four LLM defects that turned a misconfiguration into a silent
 * production problem. Each test fails if the corresponding fix is reverted.
 */

const baseConfig = {
  LLM_BASE_URL: 'https://llm.example.com/v1',
  LLM_API_KEY: 'sk-unit-test-key',
  LLM_MODEL: 'test-model',
  LLM_TIMEOUT_MS: 1_000,
  LLM_MAX_RESPONSE_BYTES: 1_024,
};

/** A response whose body streams the given bytes, so the budget is exercised. */
function streamingResponse(
  chunks: readonly string[],
  headers: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]!));
      index += 1;
    },
  });
  return new Response(stream, { status: 200, headers });
}

const validPayload = JSON.stringify({
  id: 'cmpl-1',
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
});

describe('LLM_BASE_URL fails closed at startup (Phase 14)', () => {
  it('accepts a well-formed https base url', () => {
    expect(LLMConfigSchema.safeParse({ LLM_BASE_URL: 'https://llm.example.com/v1' }).success).toBe(
      true,
    );
  });

  it('rejects a schemeless url that would fail on every request as a retryable network error', () => {
    // Before the fix this booted cleanly, then undici threw a TypeError on
    // every call, burning 3 attempts of retry per request.
    expect(LLMConfigSchema.safeParse({ LLM_BASE_URL: 'llm.example.com/v1' }).success).toBe(false);
  });

  it('rejects plaintext http for a remote host so the bearer token is never sent in cleartext', () => {
    const parsed = LLMConfigSchema.safeParse({ LLM_BASE_URL: 'http://llm.example.com/v1' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain('https');
    }
  });

  it('permits plaintext http for a loopback gateway', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1']) {
      expect(LLMConfigSchema.safeParse({ LLM_BASE_URL: url }).success).toBe(true);
    }
  });

  it('rejects embedded credentials, which would otherwise be logged on every 5xx', () => {
    expect(
      LLMConfigSchema.safeParse({ LLM_BASE_URL: 'https://user:pass@llm.example.com/v1' }).success,
    ).toBe(false);
  });

  it('rejects a query string that could smuggle a key', () => {
    expect(
      LLMConfigSchema.safeParse({ LLM_BASE_URL: 'https://llm.example.com/v1?api_key=abc' }).success,
    ).toBe(false);
  });

  it('rejects a non-http scheme', () => {
    expect(LLMConfigSchema.safeParse({ LLM_BASE_URL: 'ftp://llm.example.com/v1' }).success).toBe(
      false,
    );
  });

  it('defaults the response budget', () => {
    const parsed = LLMConfigSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.LLM_MAX_RESPONSE_BYTES).toBe(DEFAULT_LLM_MAX_RESPONSE_BYTES);
    }
  });
});

describe('HttpLLMProvider refuses to send an unauthenticated request (Phase 14)', () => {
  const request = {
    model: 'test-model',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('throws instead of sending Authorization: empty for a blank key', async () => {
    // Before the fix this sent the request with an empty Authorization header and
    // surfaced a confusing non-retryable 401 from the provider.
    const provider = new HttpLLMProvider({
      config: { ...baseConfig, LLM_API_KEY: undefined },
      fetchFn: async () => new Response(validPayload, { status: 200 }),
    });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMConfigurationError);
  });

  it('throws for a whitespace-only key', async () => {
    const provider = new HttpLLMProvider({
      config: { ...baseConfig, LLM_API_KEY: '   ' },
      fetchFn: async () => new Response(validPayload, { status: 200 }),
    });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMConfigurationError);
  });

  it('never places the api key in the request url', async () => {
    let seenUrl = '';
    const provider = new HttpLLMProvider({
      config: baseConfig,
      fetchFn: async (url: unknown) => {
        seenUrl = String(url);
        return new Response(validPayload, { status: 200 });
      },
    });
    await provider.generate(request);
    expect(seenUrl).toBe('https://llm.example.com/v1/chat/completions');
    expect(seenUrl).not.toContain('sk-unit-test-key');
  });
});

describe('HttpLLMProvider bounds the buffered upstream body (Phase 14)', () => {
  const request = {
    model: 'test-model',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('rejects a response that exceeds the byte budget mid-stream', async () => {
    // response.json() would have materialised all of this before any validation.
    const oversized = 'x'.repeat(4_096);
    const provider = new HttpLLMProvider({
      config: { ...baseConfig, LLM_MAX_RESPONSE_BYTES: 1_024 },
      fetchFn: async () => streamingResponse([validPayload, oversized, oversized]),
    });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMResponseValidationError);
  });

  it('rejects early on an oversized content-length without reading the body', async () => {
    const provider = new HttpLLMProvider({
      config: { ...baseConfig, LLM_MAX_RESPONSE_BYTES: 1_024 },
      fetchFn: async () => streamingResponse([validPayload], { 'content-length': '999999' }),
    });
    await expect(provider.generate(request)).rejects.toThrow(/exceeding the 1024 byte limit/);
  });

  it('does not trust a content-length that understates the body', async () => {
    const provider = new HttpLLMProvider({
      config: { ...baseConfig, LLM_MAX_RESPONSE_BYTES: 1_024 },
      fetchFn: async () =>
        streamingResponse([validPayload, 'y'.repeat(8_192)], { 'content-length': '10' }),
    });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMResponseValidationError);
  });

  it('still accepts a normal response at or under the budget', async () => {
    const provider = new HttpLLMProvider({
      config: { ...baseConfig, LLM_MAX_RESPONSE_BYTES: 65_536 },
      fetchFn: async () => streamingResponse([validPayload]),
    });
    const response = await provider.generate(request);
    expect(response.text).toBe('ok');
    expect(response.provider).toBe('http');
  });

  it('falls back to response.json() when no stream is exposed', async () => {
    const provider = new HttpLLMProvider({
      config: { ...baseConfig, LLM_MAX_RESPONSE_BYTES: 65_536 },
      fetchFn: async () => new Response(validPayload, { status: 200 }),
    });
    const response = await provider.generate(request);
    expect(response.text).toBe('ok');
  });
});

describe('HttpLLMProvider does not reflect upstream content into errors (Phase 14)', () => {
  const request = {
    model: 'test-model',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('clamps and strips control characters from upstream statusText', async () => {
    // statusText is the upstream server's own reason phrase; interpolating it
    // verbatim into an Error.message is a log-injection channel.
    const hostile = 'Bad\r\nFAKE LOG LINE: injected';
    const provider = new HttpLLMProvider({
      config: baseConfig,
      fetchFn: async () => new Response('{}', { status: 400, statusText: hostile } as ResponseInit),
    });
    await expect(provider.generate(request)).rejects.toSatisfy((error: unknown) => {
      const message = (error as Error).message;
      return !message.includes('\n') && !message.includes('\r');
    });
  });

  it('does not leak base-url userinfo into a 5xx error message', async () => {
    const provider = new HttpLLMProvider({
      // Constructed directly, bypassing schema validation, to prove the scrub
      // happens at the point of use and not only in config validation.
      config: { ...baseConfig, LLM_BASE_URL: 'https://user:sup3rsecret@llm.example.com/v1' },
      fetchFn: async () => new Response('{}', { status: 503, statusText: 'unavailable' }),
    });
    await expect(provider.generate(request)).rejects.toSatisfy((error: unknown) => {
      const serialized = `${(error as Error).message}${(error as { details?: unknown }).details ? JSON.stringify((error as { details?: unknown }).details) : ''}`;
      return !serialized.includes('sup3rsecret');
    });
  });

  it('keeps the api key out of a 401 error entirely', async () => {
    const provider = new HttpLLMProvider({
      config: baseConfig,
      fetchFn: async () => new Response('{}', { status: 401, statusText: 'Unauthorized' }),
    });
    await expect(provider.generate(request)).rejects.toSatisfy((error: unknown) => {
      const serialized = `${(error as Error).message}${(error as { details?: unknown }).details ? JSON.stringify((error as { details?: unknown }).details) : ''}`;
      return !serialized.includes('sk-unit-test-key');
    });
  });
});
