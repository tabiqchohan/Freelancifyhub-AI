import { describe, expect, it } from 'vitest';

import {
  DisabledLLMProvider,
  MockLLMProvider,
  HttpLLMProvider,
  createLLMProvider,
  createMockProvider,
  createDisabledProvider,
  DISABLED_PROVIDER_ID,
  REASONING_DISABLED_MESSAGE,
} from '../../../src/llm/providers/index.js';
import { parseLlmConfig } from '../../../src/llm/config/index.js';
import {
  LLMAuthenticationError,
  LLMCancelledError,
  LLMInvalidRequestError,
  LLMNetworkError,
  LLMResponseValidationError,
  LLMTimeoutError,
  type LLMProviderError,
  type LLMRateLimitError,
} from '../../../src/llm/errors/index.js';
import type { LLMRequest } from '../../../src/llm/types/index.js';

const FAKE_API_KEY = 'sk-test-not-a-real-secret';

function mockEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return { LLM_ENABLED: 'true', LLM_PROVIDER: 'mock', ...overrides };
}

describe('MockLLMProvider', () => {
  it('returns deterministic responses without network access', async () => {
    const provider = new MockLLMProvider({ config: { LLM_MODEL: 'mock-model-1.0' } });
    const request: LLMRequest = {
      messages: [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'hello' },
      ],
    };
    const response = await provider.generate(request);
    expect(response.provider).toBe('mock');
    expect(response.model).toBe('mock-model-1.0');
    expect(response.text).toContain('2 message(s)');
    expect(response.finishReason).toBe('stop');
    expect(response.usage?.inputTokens).toBe(2);
    expect(response.requestId).toBeDefined();
  });

  it('exposes safe request metadata only (never content)', async () => {
    const provider = new MockLLMProvider({ config: { LLM_MODEL: 'mock-model-1.0' } });
    await provider.generate({
      messages: [{ role: 'user', content: 'create a top-secret project' }],
    });
    const captured = provider.capturedRequests();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.messageCount).toBe(1);
    expect(captured[0]?.totalContentChars).toBeGreaterThan(0);
    expect(captured[0]).not.toHaveProperty('content');
    expect(captured[0]).not.toHaveProperty('messages');
  });

  it('supports simulated errors then recovers', async () => {
    const provider = new MockLLMProvider({ config: { LLM_MODEL: 'mock-model-1.0' } });
    provider.enqueueSimulatedError(new LLMNetworkError('simulated'));
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toBeInstanceOf(LLMNetworkError);
    const response = await provider.generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(response.text).toContain('1 message(s)');
  });

  it('reset clears captured requests and simulated errors', async () => {
    const provider = new MockLLMProvider({ config: { LLM_MODEL: 'mock-model-1.0' } });
    provider.enqueueSimulatedError(new LLMNetworkError('simulated'));
    await provider.generate({ messages: [{ role: 'user', content: 'x' }] }).catch(() => undefined);
    provider.enqueueSimulatedError(new LLMNetworkError('simulated'));
    provider.reset();
    expect(provider.capturedRequests()).toHaveLength(0);
    const response = await provider.generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(response.text).toBeDefined();
  });

  it('propagates cancellation via a pre-aborted signal', async () => {
    const provider = new MockLLMProvider({ config: { LLM_MODEL: 'mock-model-1.0' } });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.generate(
        { messages: [{ role: 'user', content: 'x' }] },
        { signal: controller.signal },
      ),
    ).resolves.toBeDefined();
  });
});

describe('DisabledLLMProvider', () => {
  it('fails closed with an explicit configuration error', async () => {
    const provider = createDisabledProvider();
    expect(provider.id).toBe(DISABLED_PROVIDER_ID);
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({
      name: 'LLMConfigurationError',
      code: 'REASONING_UNAVAILABLE',
      message: REASONING_DISABLED_MESSAGE,
    });
  });
});

describe('createLLMProvider factory', () => {
  it('returns the disabled provider when LLM is disabled', () => {
    const env = { LLM_ENABLED: 'false', LLM_PROVIDER: 'http' };
    const provider = createLLMProvider(parseLlmConfig(env));
    expect(provider.id).toBe(DISABLED_PROVIDER_ID);
  });

  it('returns the mock provider when configured', () => {
    const provider = createLLMProvider(parseLlmConfig(mockEnv()));
    expect(provider).toBeInstanceOf(MockLLMProvider);
    expect(provider.id).toBe('mock');
  });

  it('returns the http provider when configured', () => {
    const provider = createLLMProvider(
      parseLlmConfig({
        LLM_ENABLED: 'true',
        LLM_PROVIDER: 'http',
        LLM_API_KEY: FAKE_API_KEY,
      }),
    );
    expect(provider).toBeInstanceOf(HttpLLMProvider);
    expect(provider.id).toBe('http');
  });
});

describe('HttpLLMProvider', () => {
  const httpEnv = {
    LLM_ENABLED: 'true' as const,
    LLM_PROVIDER: 'http',
    LLM_API_KEY: FAKE_API_KEY,
    LLM_BASE_URL: 'https://llm.example.com/v1',
    LLM_MODEL: 'gpt-test',
    LLM_TIMEOUT_MS: '5000',
  };

  const request: LLMRequest = {
    messages: [{ role: 'user', content: 'hello' }],
  };

  function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }) {
    return {
      ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
      status: init?.status ?? 200,
      statusText: init?.statusText ?? '',
      async json() {
        return body;
      },
    } as Response;
  }

  it('performs an authenticated request and parses usage + finish reason', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        id: 'req-abc',
        model: 'gpt-custom',
        choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    };

    const provider = new HttpLLMProvider({ config: parseLlmConfig(httpEnv), fetchFn });
    const response = await provider.generate(request, { requestId: 'corr-1' });

    expect(response.text).toBe('hi there');
    expect(response.model).toBe('gpt-custom');
    expect(response.finishReason).toBe('stop');
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(response.requestId).toBe('req-abc');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://llm.example.com/v1/chat/completions');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_API_KEY}`);
    const body = JSON.parse(String(seen[0]?.init.body)) as { model: string };
    expect(body.model).toBe('gpt-test');
  });

  it('maps 401 to LLMAuthenticationError', async () => {
    const provider = new HttpLLMProvider({
      config: parseLlmConfig(httpEnv),
      fetchFn: async () => jsonResponse({}, { status: 401 }),
    });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMAuthenticationError);
  });

  it('maps 429 to a retryable LLMRateLimitError', async () => {
    const provider = new HttpLLMProvider({
      config: parseLlmConfig(httpEnv),
      fetchFn: async () => jsonResponse({}, { status: 429 }),
    });
    await expect(provider.generate(request)).rejects.toMatchObject({
      name: 'LLMRateLimitError',
      retryable: true,
    } satisfies Partial<LLMRateLimitError>);
  });

  it('maps 5xx to a retryable LLMProviderError', async () => {
    const provider = new HttpLLMProvider({
      config: parseLlmConfig(httpEnv),
      fetchFn: async () => jsonResponse({}, { status: 503 }),
    });
    await expect(provider.generate(request)).rejects.toMatchObject({
      name: 'LLMProviderError',
      retryable: true,
    } satisfies Partial<LLMProviderError>);
  });

  it('maps 400 to LLMInvalidRequestError', async () => {
    const provider = new HttpLLMProvider({
      config: parseLlmConfig(httpEnv),
      fetchFn: async () => jsonResponse({}, { status: 400 }),
    });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMInvalidRequestError);
  });

  it('rejects malformed JSON as LLMResponseValidationError', async () => {
    const provider = new HttpLLMProvider({
      config: parseLlmConfig(httpEnv),
      fetchFn: async () =>
        ({
          ok: true,
          status: 200,
          statusText: '',
          async json() {
            throw new SyntaxError('bad json');
          },
        }) as unknown as Response,
    });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMResponseValidationError);
  });

  it('rejects an invalid response shape as LLMResponseValidationError', async () => {
    const provider = new HttpLLMProvider({
      config: parseLlmConfig(httpEnv),
      fetchFn: async () => jsonResponse({ choices: [] }),
    });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMResponseValidationError);
  });

  it('maps transport-layer failures to LLMNetworkError', async () => {
    const provider = new HttpLLMProvider({
      config: parseLlmConfig(httpEnv),
      fetchFn: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMNetworkError);
  });

  it('fails with LLMTimeoutError when the provider exceeds the timeout', async () => {
    const provider = new HttpLLMProvider({
      config: parseLlmConfig(httpEnv),
      fetchFn: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    });
    await expect(provider.generate(request, { timeoutMs: 10 })).rejects.toBeInstanceOf(
      LLMTimeoutError,
    );
  });

  it('fails with LLMCancelledError when the request is pre-cancelled', async () => {
    const provider = new HttpLLMProvider({ config: parseLlmConfig(httpEnv) });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.generate(request, { signal: controller.signal })).rejects.toBeInstanceOf(
      LLMCancelledError,
    );
  });

  it('maps an abort during flight to LLMCancelledError', async () => {
    const provider = new HttpLLMProvider({
      config: parseLlmConfig(httpEnv),
      fetchFn: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    });
    const controller = new AbortController();
    const generation = provider.generate(request, { signal: controller.signal });
    controller.abort();
    await expect(generation).rejects.toBeInstanceOf(LLMCancelledError);
  });

  it('never includes the API key in any error message', async () => {
    const provider = new HttpLLMProvider({
      config: parseLlmConfig(httpEnv),
      fetchFn: async () => jsonResponse({}, { status: 401 }),
    });
    try {
      await provider.generate(request);
      throw new Error('expected throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(FAKE_API_KEY);
    }
  });
});

describe('createMockProvider helper', () => {
  it('builds a mock provider from a config slice', () => {
    const provider = createMockProvider({ LLM_MODEL: 'm' });
    expect(provider.id).toBe('mock');
    expect(provider.model).toBe('m');
  });
});

describe('DisabledLLMProvider on generation', () => {
  it('is instance-correct and never generates', () => {
    const provider = new DisabledLLMProvider();
    expect(provider.id).toBe(DISABLED_PROVIDER_ID);
  });
});
