/**
 * Sprint 26 — AIOS gateway (the public request entry point).
 *
 * Implements {@link AiosGatewayContract}: handles idempotency, delegates
 * pipeline execution, and surfaces bounded status/cancel operations. The
 * gateway is the outermost layer of the AIOS boundary — it never exposes
 * internal errors; every failure is mapped to a typed {@link AiosResponse}
 * or an {@link AiosError} with a stable HTTP status.
 */

import { toAiosError } from './errors.js';
import type { AiosError } from './errors.js';
import { AiosErrorCode } from './errors.js';
import { AiosStage, type AiosRequest, type AiosResponse, type AiosStatus } from './types.js';
import type { AiosGatewayContract } from './types.js';
import type { AiosConfig } from './config.js';
import type { AiosMetrics } from './metrics.js';
import { AiosIdempotencyRegistry, UNSCOPED_IDEMPOTENCY_PRINCIPAL } from './idempotency.js';
import { validateAiosInput, normalizeTimeoutMs } from './schemas.js';
import type { AiosService } from './service.js';
import type { AiosPipeline, AiosPipelineInput } from './pipeline.js';

export interface AiosGatewayOptions {
  readonly config: AiosConfig;
  readonly pipeline: AiosPipeline;
  readonly service: AiosService;
  readonly metrics: AiosMetrics;
  /** Injectable clock for deterministic health tests (default: Date.now). */
  readonly clock?: () => number;
}

/**
 * Codes that indicate the AIOS itself is degrading rather than a normal
 * per-request rejection. Only these degrade the gateway health signal, so a
 * burst of client validation errors never flips the platform unhealthy.
 */
const HEALTH_DEGRADING_CODES: ReadonlySet<AiosErrorCode> = new Set<AiosErrorCode>([
  AiosErrorCode.Internal,
  AiosErrorCode.ExecutionFailed,
  AiosErrorCode.DeadlineExceeded,
  AiosErrorCode.RouteUnavailable,
  AiosErrorCode.AgentNotReady,
]);

/** An infra failure observed within this window marks the gateway unhealthy. */
export const HEALTH_DEGRADED_WINDOW_MS = 60_000;

/**
 * The AIOS gateway: the single, typed entry point for inbound requests.
 *
 * Responsibilities:
 *  - Idempotency claim/replay/conflict detection
 *  - Pipeline execution (13-stage phase chain)
 *  - Request cancellation
 *  - Bounded status snapshots (never secrets)
 */
export class AiosGateway implements AiosGatewayContract {
  readonly name = 'ai-operating-system';
  readonly version = '1.0.0';

  private readonly config: AiosConfig;
  private readonly pipeline: AiosPipeline;
  private readonly service: AiosService;
  private readonly metrics: AiosMetrics;
  private readonly idempotency: AiosIdempotencyRegistry;
  private readonly clock: () => number;
  /** Most recent infra-class failure timestamp; drives the real health signal. */
  private lastInfraFailureAtMs: number | undefined;

  constructor(options: AiosGatewayOptions) {
    this.config = options.config;
    this.pipeline = options.pipeline;
    this.service = options.service;
    this.metrics = options.metrics;
    this.idempotency = new AiosIdempotencyRegistry(this.config.AIOS_IDEMPOTENCY_WINDOW_MS);
    this.clock = options.clock ?? Date.now;
  }

  async request(req: AiosRequest): Promise<AiosResponse> {
    const requestId = req.requestId;

    const input: AiosPipelineInput = {
      requestId,
      traceId: req.traceId ?? `trace-${requestId}`,
      actor: req.actor,
      input: validateAiosInput(req.input, this.config),
      options: {
        ...req.options,
        timeoutMs: normalizeTimeoutMs(req.options?.timeoutMs, this.config),
      },
    };

    // Claim AFTER validation so an invalid payload never consumes a key.
    // Sprint 35 F-6 — the keyspace is scoped to the trusted principal, so one
    // caller can neither collide with nor replay another caller's response.
    const principalId = idempotencyPrincipal(req);
    const idempotencyKey = req.options?.idempotencyKey;
    if (idempotencyKey !== undefined) {
      const claim = this.idempotency.claim(principalId, idempotencyKey, requestId);
      if (claim.outcome === 'replay') {
        return claim.response;
      }
      if (claim.outcome === 'conflict') {
        this.idempotency.throwConflict(claim.existingRequestId, idempotencyKey);
      }
    }

    try {
      const response = await this.pipeline.execute(input);
      if (idempotencyKey !== undefined) {
        this.idempotency.complete(principalId, idempotencyKey, response);
      }
      return response;
    } catch (error) {
      // Sprint 33 — a failed/timed-out request must not pin the idempotency
      // key for the rest of the window; release it so retries replay cleanly.
      if (idempotencyKey !== undefined) {
        this.idempotency.release(principalId, idempotencyKey);
      }
      // Sprint 34 — record infra-class failures so status() reflects real
      // health instead of hardcoding healthy.
      const aios = toAiosError(error);
      if (HEALTH_DEGRADING_CODES.has(aios.code)) {
        this.lastInfraFailureAtMs = this.clock();
      }
      throw error;
    }
  }

  status(requestId?: string): AiosStatus {
    if (requestId !== undefined) {
      return this.requestStatus(requestId);
    }
    return this.overallStatus();
  }

  cancel(requestId: string): void {
    this.service.cancel(requestId);
  }

  private requestStatus(requestId: string): AiosStatus {
    const result = this.service.lastResult(requestId);
    const isActive = this.service.isActive(requestId);
    return {
      enabled: true,
      healthy: true,
      stage:
        result !== undefined
          ? AiosStage.Completed
          : isActive
            ? AiosStage.Execute
            : AiosStage.Validate,
      activeRequests: isActive ? 1 : 0,
      completedRequests: result !== undefined ? 1 : 0,
      requestCounts: {},
      statusCounts: result !== undefined ? { [result.status]: 1 } : {},
      // Sprint 35 F-5 — expose the *stable error code* only. The previous
      // `result.error.message` published raw internal failure text (driver,
      // provider or host detail) to any caller able to name a request id.
      // Callers must correlate with the stable code, not parse internal text.
      lastFailure: result?.error?.code,
      since: new Date().toISOString(),
    };
  }

  private overallStatus(): AiosStatus {
    const statusCounts = this.metrics.statusCounts();
    const allCount = Object.values(statusCounts).reduce((sum, value) => sum + value, 0);
    // Sprint 34 — real health signal: degraded for HEALTH_DEGRADED_WINDOW_MS
    // after any infra-class failure, then self-heals.
    const healthy =
      this.lastInfraFailureAtMs === undefined ||
      this.clock() - this.lastInfraFailureAtMs > HEALTH_DEGRADED_WINDOW_MS;
    return {
      enabled: true,
      healthy,
      stage: AiosStage.Completed,
      activeRequests: this.service.activeCount(),
      completedRequests: allCount,
      requestCounts: this.metrics.intents(),
      statusCounts,
      lastFailure: undefined,
      since: this.metrics.snapshot().since,
    };
  }
}

/** Maps any failure into a bounded {@link AiosError} (never leaks internals). */
export function toGatewayError(error: unknown): AiosError {
  return toAiosError(error);
}

/**
 * Sprint 35 F-6 — principal used for the idempotency keyspace. When the
 * service boundary has bound a trusted principal to the request, that identity
 * is used; otherwise a single, conservative fallback scope is applied.
 */
export function idempotencyPrincipal(req: AiosRequest): string {
  if (req.principalId !== undefined && req.principalId.length > 0) {
    return req.principalId;
  }
  return UNSCOPED_IDEMPOTENCY_PRINCIPAL;
}
