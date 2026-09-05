import type { LLMConfig } from '../config/schema.js';
import { LLM_PROVIDER_HTTP, LLM_PROVIDER_MOCK } from '../constants.js';
import type { LLMProvider } from '../types/index.js';
import { createDisabledProvider } from './disabled.js';
import { createHttpProvider } from './http.js';
import { createMockProvider } from './mock.js';

export { DISABLED_PROVIDER_ID, REASONING_DISABLED_MESSAGE } from './disabled.js';
export { MockLLMProvider, createMockProvider } from './mock.js';
export type { MockCapturedRequest, MockLLMProviderOptions } from './mock.js';
export { HttpLLMProvider, createHttpProvider } from './http.js';
export type { HttpLLMProviderOptions } from './http.js';
export { DisabledLLMProvider, createDisabledProvider } from './disabled.js';

/**
 * Builds the provider selected by an LLM configuration. A disabled
 * configuration always yields the failing-closed {@link DisabledLLMProvider};
 * otherwise the configured provider (`mock` or `http`).
 */
export function createLLMProvider(
  config: LLMConfig,
  options: { readonly fetchFn?: typeof fetch } = {},
): LLMProvider {
  if (!config.LLM_ENABLED) {
    return createDisabledProvider();
  }
  switch (config.LLM_PROVIDER) {
    case LLM_PROVIDER_MOCK:
      return createMockProvider(config);
    case LLM_PROVIDER_HTTP:
      return createHttpProvider(config, options.fetchFn);
    default:
      return createDisabledProvider();
  }
}
