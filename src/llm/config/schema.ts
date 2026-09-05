import { z } from 'zod';

import { LLM_PROVIDER_HTTP, LLM_PROVIDER_MOCK } from '../constants.js';

/** Default: reasoning feature flag. */
export const DEFAULT_LLM_ENABLED = false;
/** Default provider id. */
export const DEFAULT_LLM_PROVIDER = LLM_PROVIDER_MOCK;
/** Default model identity (clearly a placeholder, never a real SDK default). */
export const DEFAULT_LLM_MODEL = 'mock-model-1.0';
/** Default base URL for the OpenAI-compatible HTTP provider. */
export const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';
/** Default per-request timeout. */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;
/** Default retry count (number of retries after the first attempt). */
export const DEFAULT_LLM_MAX_RETRIES = 2;
/** Default sampling temperature. */
export const DEFAULT_LLM_TEMPERATURE = 0.2;
/** Default max output tokens. */
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 1024;
/** Default max context bytes sent to a provider. */
export const DEFAULT_LLM_MAX_CONTEXT_BYTES = 64 * 1024;

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const nonEmptyOptionalString = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

/**
 * Typed runtime configuration for the LLM Provider & AI Reasoning layer.
 * Fields are driven by environment variables with safe defaults.
 *
 * Secrets: `LLM_API_KEY` is never logged, emitted, persisted, or surfaced in
 * errors. Parsing is fail-closed: an unknown provider is rejected, and an
 * enabled HTTP provider without credentials aborts configuration.
 */
export const LLMConfigSchema = z.object({
  /** Feature flag: AI reasoning capability. */
  LLM_ENABLED: booleanFromString.default(DEFAULT_LLM_ENABLED),
  /** Provider id: `mock` (deterministic, no network) or `http`. */
  LLM_PROVIDER: z.enum([LLM_PROVIDER_MOCK, LLM_PROVIDER_HTTP]).default(DEFAULT_LLM_PROVIDER),
  /** Model identity. */
  LLM_MODEL: z.string().trim().min(1).default(DEFAULT_LLM_MODEL),
  /** Provider secret (OpenAI-compatible). Optional for mock/disabled setups. */
  LLM_API_KEY: nonEmptyOptionalString,
  /** Base URL for the HTTP provider (OpenAI-compatible chat completions). */
  LLM_BASE_URL: z.string().trim().min(1).default(DEFAULT_LLM_BASE_URL),
  /** Per-request timeout. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_LLM_TIMEOUT_MS),
  /** Retry count after the first attempt. */
  LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(DEFAULT_LLM_MAX_RETRIES),
  /** Sampling temperature in [0, 2]. */
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(DEFAULT_LLM_TEMPERATURE),
  /** Max output tokens. */
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(DEFAULT_LLM_MAX_OUTPUT_TOKENS),
  /** Max context bytes assembled into a single user message. */
  LLM_MAX_CONTEXT_BYTES: z.coerce.number().int().positive().default(DEFAULT_LLM_MAX_CONTEXT_BYTES),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
