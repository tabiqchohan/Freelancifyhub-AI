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
/**
 * Default ceiling on the upstream response body we are willing to buffer.
 * A chat completion of `LLM_MAX_OUTPUT_TOKENS` is far below this, so anything
 * larger is either a misconfigured endpoint or a hostile one.
 */
export const DEFAULT_LLM_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Hosts for which plaintext http to the LLM gateway is acceptable. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const nonEmptyOptionalString = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

/**
 * Prompts15 Phase 14 — the base URL was previously only length-checked, so
 * `llm.example.com/v1` (no scheme) or a plaintext `http://` endpoint booted
 * cleanly and then failed on *every* request as a retryable network error.
 *
 * A misconfigured endpoint must fail closed at startup, and it must not be able
 * to smuggle a credential: `https://user:pass@host/v1` would otherwise end up
 * printed verbatim in error details (see `HttpLLMProvider.mapHttpError`).
 */
const llmBaseUrl = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be an absolute URL including a scheme, e.g. https://api.openai.com/v1',
      });
      return;
    }

    // Plaintext http is tolerated only for a local OpenAI-compatible gateway
    // (llama.cpp, Ollama, vLLM) on loopback, so it cannot weaken the
    // cleartext-bearer rule for a real remote endpoint.
    if (parsed.protocol === 'http:') {
      if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'must use https so the bearer token is never sent in cleartext; plaintext http is only permitted for a loopback gateway (localhost, 127.0.0.1, ::1)',
        });
      }
      return;
    }

    if (parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must use https, got scheme "${parsed.protocol}"`,
      });
      return;
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must not embed credentials; use LLM_API_KEY instead',
      });
      return;
    }
    if (parsed.search.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must not contain a query string',
      });
    }
  });

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
  LLM_BASE_URL: llmBaseUrl.default(DEFAULT_LLM_BASE_URL),
  /** Per-attempt timeout. Retries can extend total wall-clock time beyond this. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_LLM_TIMEOUT_MS),
  /**
   * Ceiling on buffered upstream response bytes. Guards against a misconfigured
   * or hostile endpoint exhausting memory, since `response.json()` would
   * otherwise materialise an arbitrarily large body before validation runs.
   */
  LLM_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LLM_MAX_RESPONSE_BYTES),
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
