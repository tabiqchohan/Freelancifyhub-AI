import { MemoryValidationError } from '../errors/index.js';

/** Integration error categories exposed to AG-001 (prompt §19). */
export enum MemoryIntegrationErrorCategory {
  /** Configuration missing or invalid. */
  Configuration = 'configuration',
  /** Authorization / security denial. */
  Authorization = 'authorization',
  /** Memory integration not operational. */
  Unavailable = 'unavailable',
  /** Bounded execution time exceeded. */
  Timeout = 'timeout',
  /** Request was cancelled. */
  Cancellation = 'cancellation',
  /** Integration returned an invalid/unsupported shape. */
  InvalidResponse = 'invalid_response',
  /** Unclassified internal failure. */
  Internal = 'internal',
}

/**
 * A typed integration error that never leaks AG-002 implementation details or
 * secrets into AG-001 (prompt §19). The message is deliberately generic; any
 * sensitive detail stays in the `details` map only when it contains no secrets.
 */
export class MemoryIntegrationError extends Error {
  override readonly name = 'MemoryIntegrationError';
  readonly category: MemoryIntegrationErrorCategory;
  readonly retryable: boolean;
  override readonly cause?: unknown;
  /** Optional, secret-free correlation metadata. */
  readonly traceId?: string;

  constructor(
    message: string,
    options: {
      category: MemoryIntegrationErrorCategory;
      retryable?: boolean;
      cause?: unknown;
      traceId?: string;
    },
  ) {
    super(message);
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
    this.traceId = options.traceId;
  }
}

/** Deterministic, secret-free category classifier for unknown thrown values. */
export function classifyIntegrationFailure(error: unknown): {
  category: MemoryIntegrationErrorCategory;
  retryable: boolean;
  message: string;
} {
  if (error instanceof MemoryIntegrationError) {
    return {
      category: error.category,
      retryable: error.retryable,
      message: error.message,
    };
  }

  if (
    error instanceof MemoryValidationError ||
    (error instanceof Error && error.name === 'MemoryValidationError')
  ) {
    return {
      category: MemoryIntegrationErrorCategory.InvalidResponse,
      retryable: false,
      message: 'memory integration received an invalid response',
    };
  }

  if (
    error instanceof Error &&
    (error.message.includes('cancel') || error.message.toLowerCase().includes('abort'))
  ) {
    return {
      category: MemoryIntegrationErrorCategory.Cancellation,
      retryable: false,
      message: 'memory integration was cancelled',
    };
  }

  if (error instanceof Error && error.message.toLowerCase().includes('timeout')) {
    return {
      category: MemoryIntegrationErrorCategory.Timeout,
      retryable: true,
      message: 'memory integration timed out',
    };
  }

  return {
    category: MemoryIntegrationErrorCategory.Internal,
    retryable: false,
    message: 'memory integration failed',
  };
}

/** Builds a safe, generic integration error (never forwards raw internals). */
export function toMemoryIntegrationError(error: unknown, traceId?: string): MemoryIntegrationError {
  const classified = classifyIntegrationFailure(error);
  return new MemoryIntegrationError(classified.message, {
    category: classified.category,
    retryable: classified.retryable,
    cause: error,
    traceId,
  });
}
