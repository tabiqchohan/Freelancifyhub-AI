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
import { AiosStage, type AiosRequest, type AiosResponse, type AiosStatus } from './types.js';
import type { AiosGatewayContract } from './types.js';
import type { AiosConfig } from './config.js';
import type { AiosMetrics } from './metrics.js';
import { AiosIdempotencyRegistry } from './idempotency.js';
import { validateAiosInput, normalizeTimeoutMs } from './schemas.js';
import type { AiosService } from './service.js';
import type { AiosPipeline, AiosPipelineInput } from './pipeline.js';

export interface AiosGatewayOptions {
  readonly config: AiosConfig;
  readonly pipeline: AiosPipeline;
  readonly service: AiosService;
  readonly metrics: AiosMetrics;
}

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

  constructor(options: AiosGatewayOptions) {
    this.config = options.config;
    this.pipeline = options.pipeline;
    this.service = options.service;
    this.metrics = options.metrics;
    this.idempotency = new AiosIdempotencyRegistry(this.config.AIOS_IDEMPOTENCY_WINDOW_MS);
  }

  async request(req: AiosRequest): Promise<AiosResponse> {
    const requestId = req.requestId;

    if (req.options?.idempotencyKey !== undefined) {
      const claim = this.idempotency.claim(req.options.idempotencyKey, requestId);
      if (claim.outcome === 'replay') {
        return claim.response;
      }
      if (claim.outcome === 'conflict') {
        this.idempotency.throwConflict(claim.existingRequestId, req.options.idempotencyKey);
      }
    }

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

    const response = await this.pipeline.execute(input);

    if (req.options?.idempotencyKey !== undefined) {
      this.idempotency.complete(req.options.idempotencyKey, response);
    }

    return response;
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
      lastFailure: result?.error?.message,
      since: new Date().toISOString(),
    };
  }

  private overallStatus(): AiosStatus {
    const statusCounts = this.metrics.statusCounts();
    const allCount = Object.values(statusCounts).reduce((sum, value) => sum + value, 0);
    return {
      enabled: true,
      healthy: true,
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
