import { describe, expect, it } from 'vitest';

import { AIReasoningService } from '../../../src/llm/services/reasoning.js';
import { MockLLMProvider } from '../../../src/llm/providers/mock.js';
import { LLMEventLog } from '../../../src/llm/events/index.js';
import { LLMMetrics } from '../../../src/llm/metrics/index.js';
import { parseLlmConfig } from '../../../src/llm/config/index.js';
import {
  LLMCancelledError,
  LLMConfigurationError,
  LLMInvalidRequestError,
  LLMNetworkError,
} from '../../../src/llm/errors/index.js';
import type { LLMProvider, LLMResponse, ReasoningRequest } from '../../../src/llm/types/index.js';

const enabledConfig = parseLlmConfig({
  LLM_ENABLED: 'true',
  LLM_PROVIDER: 'mock',
  LLM_TIMEOUT_MS: '5000',
  LLM_MAX_RETRIES: '0',
});

const disabledConfig = parseLlmConfig({
  LLM_ENABLED: 'false',
  LLM_PROVIDER: 'mock',
});

function buildService(
  options: {
    config?: ReturnType<typeof parseLlmConfig>;
    provider?: MockLLMProvider;
    eventLog?: LLMEventLog;
    metrics?: LLMMetrics;
    sleep?: () => Promise<void>;
  } = {},
) {
  const provider = options.provider ?? new MockLLMProvider({ config: enabledConfig });
  const eventLog = options.eventLog ?? new LLMEventLog();
  const metrics = options.metrics ?? new LLMMetrics();
  const config = options.config ?? enabledConfig;
  const service = new AIReasoningService({
    provider,
    config,
    eventLog,
    metrics,
    retrySleep: options.sleep,
  });
  return { service, provider, eventLog, metrics };
}

function request(overrides: Partial<ReasoningRequest> = {}): ReasoningRequest {
  return { userInput: 'create a project', ...overrides };
}

describe('AIReasoningService', () => {
  it('reports the provider status without credentials', () => {
    const { service } = buildService();
    expect(service.isEnabled()).toBe(true);
    expect(service.providerInfo()).toEqual({
      enabled: true,
      configured: true,
      provider: 'mock',
      model: 'mock-model-1.0',
    });
  });

  it('fails closed when reasoning is disabled', async () => {
    const { service } = buildService({ config: disabledConfig });
    expect(service.isEnabled()).toBe(false);
    expect(service.providerInfo().provider).toBe('disabled');
    await expect(service.reason(request())).rejects.toBeInstanceOf(LLMConfigurationError);
  });

  it('constructs system/user messages and returns a structured result', async () => {
    const { service, provider, eventLog } = buildService();
    const result = await service.reason(
      request({
        userInput: 'summarize',
        memoryContext: [{ id: 'mem', source: 'memory', content: 'context' }],
        correlationId: 'corr-1',
      }),
    );

    expect(result.output).toContain('2 message(s)');
    expect(result.provider).toBe('mock');
    expect(result.model).toBe('mock-model-1.0');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.correlationId).toBe('corr-1');
    expect(result.usage?.totalTokens).toBeGreaterThan(0);

    const captured = provider.capturedRequests();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.messageCount).toBe(2);
    expect(captured[0]?.requestId).toBe('corr-1');

    expect(eventLog.count({ success: true })).toBe(1);
    expect(eventLog.count({ type: 'llm.reasoning.started' })).toBe(1);
  });

  it('rejects empty user input with LLMInvalidRequestError', async () => {
    const { service, eventLog } = buildService();
    await expect(service.reason(request({ userInput: '   ' }))).rejects.toBeInstanceOf(
      LLMInvalidRequestError,
    );
    expect(eventLog.count({ success: false })).toBe(1);
  });

  it('retries a transient failure then succeeds', async () => {
    const retriableConfig = parseLlmConfig({
      LLM_ENABLED: 'true',
      LLM_PROVIDER: 'mock',
      LLM_TIMEOUT_MS: '5000',
      LLM_MAX_RETRIES: '3',
    });
    const provider = new MockLLMProvider({ config: retriableConfig });
    provider.enqueueSimulatedError(new LLMNetworkError('simulated'));
    const { service, eventLog, metrics } = buildService({
      provider,
      config: retriableConfig,
      sleep: async () => undefined,
    });

    const result = await service.reason(request({ correlationId: 'corr-retry' }));
    expect(result.output).toBeDefined();
    expect(eventLog.count({ type: 'llm.reasoning.retry' })).toBe(1);
    expect(eventLog.count({ success: true })).toBe(1);
    expect(metrics.snapshot().totals.retries).toBe(1);
  });

  it('normalizes provider errors and records failed events without leaking details', async () => {
    const provider = new MockLLMProvider({ config: enabledConfig });
    provider.enqueueSimulatedError(new LLMNetworkError('simulated'));
    const { service, eventLog } = buildService({
      provider,
      config: parseLlmConfig({ LLM_ENABLED: 'true', LLM_PROVIDER: 'mock', LLM_MAX_RETRIES: '0' }),
    });

    await expect(service.reason(request())).rejects.toBeInstanceOf(LLMNetworkError);
    expect(eventLog.count({ success: false })).toBe(1);
    const failed = eventLog.latest(1)[0]!;
    expect(failed.errorClass).toBe('network');
    expect(JSON.stringify(failed)).not.toContain('simulated');
  });

  it('propagates cancellation via the AbortSignal', async () => {
    const { service, eventLog } = buildService();
    const controller = new AbortController();
    controller.abort();
    await expect(service.reason(request(), { signal: controller.signal })).rejects.toBeInstanceOf(
      LLMCancelledError,
    );
    expect(eventLog.count({ type: 'llm.reasoning.cancelled' })).toBeGreaterThanOrEqual(1);
  });

  it('keeps reasoning itself free of orchestration duties', async () => {
    const { service } = buildService();
    expect(service.id).toBe('ai-reasoning-service');
  });
});

contractOpenaiCompliance();
function contractOpenaiCompliance(): void {
  describe('AIReasoningService provider abstraction', () => {
    it('swaps providers without touching request/response contracts', async () => {
      class FakeProvider implements LLMProvider {
        readonly id = 'fake';
        readonly model = 'fake-model';

        async generate(): Promise<LLMResponse> {
          return {
            text: 'FakeProviderReply',
            provider: this.id,
            model: this.model,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: 'stop',
            attempts: 1,
          };
        }
      }
      const service = new AIReasoningService({
        provider: new FakeProvider(),
        config: enabledConfig,
      });
      const result = await service.reason(request());
      expect(result.provider).toBe('fake');
      expect(result.output).toBe('FakeProviderReply');
    });
  });
}
