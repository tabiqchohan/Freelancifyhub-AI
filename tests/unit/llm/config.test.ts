import { describe, expect, it } from 'vitest';

import { parseLlmConfig } from '../../../src/llm/config/index.js';
import { LLMConfigurationError } from '../../../src/llm/errors/index.js';
import { LLM_PROVIDER_MOCK, LLM_PROVIDER_HTTP } from '../../../src/llm/constants.js';

describe('parseLlmConfig (Sprint 17)', () => {
  it('returns safe defaults for an empty environment', () => {
    const config = parseLlmConfig({});
    expect(config.LLM_ENABLED).toBe(false);
    expect(config.LLM_PROVIDER).toBe(LLM_PROVIDER_MOCK);
    expect(config.LLM_MODEL).toBe('mock-model-1.0');
    expect(config.LLM_BASE_URL).toBe('https://api.openai.com/v1');
    expect(config.LLM_TIMEOUT_MS).toBe(30000);
    expect(config.LLM_MAX_RETRIES).toBe(2);
    expect(config.LLM_TEMPERATURE).toBe(0.2);
    expect(config.LLM_MAX_OUTPUT_TOKENS).toBe(1024);
    expect(config.LLM_MAX_CONTEXT_BYTES).toBe(64 * 1024);
    expect(config.LLM_API_KEY).toBeUndefined();
  });

  it('parses a fully-specified configuration', () => {
    const config = parseLlmConfig({
      LLM_ENABLED: 'true',
      LLM_PROVIDER: LLM_PROVIDER_HTTP,
      LLM_MODEL: 'gpt-5',
      LLM_BASE_URL: 'https://example.com/v1',
      LLM_TIMEOUT_MS: '5000',
      LLM_MAX_RETRIES: '4',
      LLM_TEMPERATURE: '0.7',
      LLM_MAX_OUTPUT_TOKENS: '2048',
      LLM_API_KEY: 'sk-test',
    });
    expect(config.LLM_ENABLED).toBe(true);
    expect(config.LLM_PROVIDER).toBe(LLM_PROVIDER_HTTP);
    expect(config.LLM_MODEL).toBe('gpt-5');
    expect(config.LLM_TIMEOUT_MS).toBe(5000);
    expect(config.LLM_MAX_RETRIES).toBe(4);
    expect(config.LLM_TEMPERATURE).toBe(0.7);
    expect(config.LLM_MAX_OUTPUT_TOKENS).toBe(2048);
    expect(config.LLM_API_KEY).toBe('sk-test');
  });

  it('accepts boolean strings true/false only', () => {
    expect(parseLlmConfig({ LLM_ENABLED: 'true' }).LLM_ENABLED).toBe(true);
    expect(parseLlmConfig({ LLM_ENABLED: 'false' }).LLM_ENABLED).toBe(false);
    expect(() => parseLlmConfig({ LLM_ENABLED: 'yes' })).toThrow(LLMConfigurationError);
  });

  it('fails closed for an unknown provider', () => {
    expect(() => parseLlmConfig({ LLM_PROVIDER: 'claude' })).toThrow(LLMConfigurationError);
  });

  it('fails closed when http is enabled without an API key', () => {
    expect(() => parseLlmConfig({ LLM_ENABLED: 'true', LLM_PROVIDER: LLM_PROVIDER_HTTP })).toThrow(
      LLMConfigurationError,
    );
    expect(() =>
      parseLlmConfig({
        LLM_ENABLED: 'true',
        LLM_PROVIDER: LLM_PROVIDER_HTTP,
        LLM_API_KEY: '   ',
      }),
    ).toThrow(LLMConfigurationError);
  });

  it('allows a disabled provider without any API key (test/boot mode)', () => {
    const config = parseLlmConfig({ LLM_ENABLED: 'false', LLM_PROVIDER: LLM_PROVIDER_HTTP });
    expect(config.LLM_ENABLED).toBe(false);
    expect(config.LLM_PROVIDER).toBe(LLM_PROVIDER_HTTP);
    expect(config.LLM_API_KEY).toBeUndefined();
  });

  it('never leaks the API key in thrown configuration errors', () => {
    try {
      parseLlmConfig({ LLM_PROVIDER: 'nope' });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMConfigurationError);
      if (error instanceof LLMConfigurationError) {
        expect(error.message).not.toContain('sk-test');
        expect(JSON.stringify(error)).not.toContain('sk-test');
      }
    }
  });

  it('rejects invalid timeout values', () => {
    for (const value of ['0', '-5', 'abc']) {
      expect(() => parseLlmConfig({ LLM_TIMEOUT_MS: value })).toThrow(LLMConfigurationError);
    }
  });

  it('rejects invalid retry counts', () => {
    expect(() => parseLlmConfig({ LLM_MAX_RETRIES: '-1' })).toThrow(LLMConfigurationError);
    expect(() => parseLlmConfig({ LLM_MAX_RETRIES: 'x' })).toThrow(LLMConfigurationError);
  });

  it('rejects an out-of-range temperature', () => {
    expect(() => parseLlmConfig({ LLM_TEMPERATURE: '-0.1' })).toThrow(LLMConfigurationError);
    expect(() => parseLlmConfig({ LLM_TEMPERATURE: '2.5' })).toThrow(LLMConfigurationError);
  });

  it('rejects invalid max output tokens', () => {
    expect(() => parseLlmConfig({ LLM_MAX_OUTPUT_TOKENS: '0' })).toThrow(LLMConfigurationError);
    expect(() => parseLlmConfig({ LLM_MAX_OUTPUT_TOKENS: '-1' })).toThrow(LLMConfigurationError);
  });
});
