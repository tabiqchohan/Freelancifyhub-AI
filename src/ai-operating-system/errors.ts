/**
 * Sprint 26 — AIOS typed error surface. Fail-closed: every terminal failure is
 * represented by an {@link AiosError} with a stable code, an HTTP status and a
 * safe message that never echoes user text.
 */

import type { AiosStage } from './types.js';

/** Stable AIOS error codes exposed to callers. */
export enum AiosErrorCode {
  InvalidInput = 'AIOS_VALIDATION_ERROR',
  PayloadTooLarge = 'AIOS_PAYLOAD_TOO_LARGE',
  UnknownIntent = 'AIOS_UNKNOWN_INTENT',
  UnauthorizedScope = 'AIOS_UNAUTHORIZED_SCOPE',
  RouteUnavailable = 'AIOS_ROUTE_UNAVAILABLE',
  AgentNotReady = 'AIOS_AGENT_NOT_READY',
  ToolNotAllowed = 'AIOS_TOOL_NOT_ALLOWED',
  SecretDetected = 'AIOS_SECRET_DETECTED',
  IdempotencyConflict = 'AIOS_IDEMPOTENCY_CONFLICT',
  ExecutionFailed = 'AIOS_EXECUTION_FAILED',
  DeadlineExceeded = 'AIOS_DEADLINE_EXCEEDED',
  Cancelled = 'AIOS_CANCELLED',
  Internal = 'AIOS_INTERNAL_ERROR',
}

/** Stable HTTP status per error code. */
export const AIOS_ERROR_HTTP_STATUS: Readonly<Record<AiosErrorCode, number>> = {
  [AiosErrorCode.InvalidInput]: 400,
  [AiosErrorCode.PayloadTooLarge]: 413,
  [AiosErrorCode.UnknownIntent]: 422,
  [AiosErrorCode.UnauthorizedScope]: 403,
  [AiosErrorCode.RouteUnavailable]: 503,
  [AiosErrorCode.AgentNotReady]: 503,
  [AiosErrorCode.ToolNotAllowed]: 403,
  [AiosErrorCode.SecretDetected]: 400,
  [AiosErrorCode.IdempotencyConflict]: 409,
  [AiosErrorCode.ExecutionFailed]: 500,
  [AiosErrorCode.DeadlineExceeded]: 504,
  [AiosErrorCode.Cancelled]: 499,
  [AiosErrorCode.Internal]: 500,
};

/** A typed AIOS failure thrown at the boundary. */
export class AiosError extends Error {
  readonly code: AiosErrorCode;
  readonly status: number;
  readonly stage?: AiosStage;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: AiosErrorCode,
    message: string,
    options: {
      readonly stage?: AiosStage;
      readonly requestId?: string;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'AiosError';
    this.code = code;
    this.status = AIOS_ERROR_HTTP_STATUS[code];
    this.stage = options.stage;
    this.requestId = options.requestId;
    this.details = options.details;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Type guard for {@link AiosError}. */
export function isAiosError(error: unknown): error is AiosError {
  return error instanceof AiosError;
}

/** Coerces any unknown failure into a bounded {@link AiosError}. */
export function toAiosError(
  error: unknown,
  fallbackCode: AiosErrorCode = AiosErrorCode.Internal,
): AiosError {
  if (isAiosError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : 'Unclassified AIOS failure';
  return new AiosError(fallbackCode, message, { cause: error });
}
