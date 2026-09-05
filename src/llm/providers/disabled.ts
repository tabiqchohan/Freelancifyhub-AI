/**
 * Sprint 17 — Disabled LLM provider.
 *
 * Used when `LLM_ENABLED` is false. Any attempt to generate throws a
 * {@link LLMConfigurationError} so the reasoning path fails closed instead of
 * silently returning degraded output.
 */

import { LLMConfigurationError } from '../errors/index.js';
import type { LLMProvider, LLMRequest, LLMRequestOptions, LLMResponse } from '../types/index.js';

/** Built-in identity of the disabled provider. */
export const DISABLED_PROVIDER_ID = 'disabled';

/** Standard message used when reasoning is disabled. */
export const REASONING_DISABLED_MESSAGE = 'LLM reasoning is disabled by configuration';

/** A provider that never generates; fails closed when reasoning is disabled. */
export class DisabledLLMProvider implements LLMProvider {
  readonly id = DISABLED_PROVIDER_ID;
  readonly model = '';

  async generate(_request: LLMRequest, _options?: LLMRequestOptions): Promise<LLMResponse> {
    throw new LLMConfigurationError(REASONING_DISABLED_MESSAGE, {
      code: 'REASONING_UNAVAILABLE',
    });
  }
}

/** Convenience: a shared disabled provider instance. */
export function createDisabledProvider(): DisabledLLMProvider {
  return new DisabledLLMProvider();
}
