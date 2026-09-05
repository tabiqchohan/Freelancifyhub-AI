/**
 * Sprint 17 — LLM Provider & AI Reasoning Layer. Shared constants.
 */

/** Provider id: deterministic in-process mock (no network). */
export const LLM_PROVIDER_MOCK = 'mock';
/** Provider id: minimal OpenAI-compatible HTTP chat-completions. */
export const LLM_PROVIDER_HTTP = 'http';

/** Capability id that marks an agent as requiring LLM reasoning. */
export const LLM_REASONING_CAPABILITY = 'agent.reasoning';

/** Error code produced when a reasoning-required agent cannot reason. */
export const REASONING_UNAVAILABLE_CODE = 'REASONING_UNAVAILABLE';
/** Error code produced when a reasoning agent is executed without reasoning. */
export const REASONING_REQUIRED_CODE = 'REASONING_REQUIRED';

/** Default backoff for LLM retries (internal, not user configurable). */
export const DEFAULT_LLM_BACKOFF_BASE_MS = 100;
export const DEFAULT_LLM_BACKOFF_MAX_MS = 2000;
