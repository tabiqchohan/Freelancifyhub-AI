/**
 * Sprint 17 — LLM Provider error model.
 *
 * Provider-agnostic, normalized errors. Each error carries a stable `code`, a
 * `retryable` flag, and safe `details` only. API keys, authorization headers,
 * raw request payloads and credentials are never included.
 */

export type LLMErrorOptions = {
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
  readonly cause?: unknown;
};

/** Base error for the LLM Provider & AI Reasoning layer. */
export abstract class LLMError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'LLM_ERROR';
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

/** Raised when the LLM configuration is invalid or unavailable. */
export class LLMConfigurationError extends LLMError {
  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'LLM_CONFIGURATION_ERROR' });
  }
}

/** Raised when the provider rejects credentials (401/403). Never retried. */
export class LLMAuthenticationError extends LLMError {
  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'LLM_AUTHENTICATION_ERROR' });
  }
}

/** Raised when the provider rate-limits the request (429). Retried. */
export class LLMRateLimitError extends LLMError {
  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'LLM_RATE_LIMIT_ERROR', retryable: true });
  }
}

/** Raised when a request exceeds its timeout. Retried when policy permits. */
export class LLMTimeoutError extends LLMError {
  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'LLM_TIMEOUT_ERROR', retryable: true });
  }
}

/** Raised on transient transport failures (DNS, connection, 5xx from network). */
export class LLMNetworkError extends LLMError {
  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'LLM_NETWORK_ERROR', retryable: true });
  }
}

/** Raised when the request itself is invalid (400/404/422). Never retried. */
export class LLMInvalidRequestError extends LLMError {
  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'LLM_INVALID_REQUEST_ERROR' });
  }
}

/** Raised on provider-side failures (5xx) — retried under policy. */
export class LLMProviderError extends LLMError {
  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'LLM_PROVIDER_ERROR', retryable: true });
  }
}

/** Raised when the provider response fails validation. Never retried. */
export class LLMResponseValidationError extends LLMError {
  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'LLM_RESPONSE_VALIDATION_ERROR' });
  }
}

/** Raised when a request is cancelled via AbortSignal. Never retried. */
export class LLMCancelledError extends LLMError {
  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'LLM_CANCELLED_ERROR' });
  }
}

/** Raised for internal/unexpected reasoning failures. Fail-closed. */
export class LLMInternalError extends LLMError {
  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'LLM_INTERNAL_ERROR' });
  }
}

/** Stable error categories used for classification and events. */
export type LLMErrorClass =
  | 'configuration'
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'invalid_request'
  | 'provider'
  | 'response_validation'
  | 'cancelled'
  | 'internal';

/** Result of classifying a thrown value for retry/event purposes. */
export interface LLMErrorClassification {
  readonly errorClass: LLMErrorClass;
  readonly retryable: boolean;
}

/**
 * Classifies an arbitrary thrown value into the normalized LLM error model.
 * Unknown/plain errors are treated as internal and non-retryable (fail closed).
 */
export function classifyLLMError(error: unknown): LLMErrorClassification {
  if (error instanceof LLMConfigurationError) {
    return { errorClass: 'configuration', retryable: false };
  }
  if (error instanceof LLMAuthenticationError) {
    return { errorClass: 'authentication', retryable: false };
  }
  if (error instanceof LLMRateLimitError) {
    return { errorClass: 'rate_limit', retryable: true };
  }
  if (error instanceof LLMTimeoutError) {
    return { errorClass: 'timeout', retryable: true };
  }
  if (error instanceof LLMNetworkError) {
    return { errorClass: 'network', retryable: true };
  }
  if (error instanceof LLMInvalidRequestError) {
    return { errorClass: 'invalid_request', retryable: false };
  }
  if (error instanceof LLMProviderError) {
    return { errorClass: 'provider', retryable: error.retryable };
  }
  if (error instanceof LLMResponseValidationError) {
    return { errorClass: 'response_validation', retryable: false };
  }
  if (error instanceof LLMCancelledError) {
    return { errorClass: 'cancelled', retryable: false };
  }
  if (error instanceof LLMError) {
    return {
      errorClass: error.retryable ? 'provider' : 'internal',
      retryable: error.retryable,
    };
  }
  return { errorClass: 'internal', retryable: false };
}

/** Returns true when a thrown value should be retried. */
export function isLLMRetryable(error: unknown): boolean {
  return classifyLLMError(error).retryable;
}
