import type { MemoryContextStatus } from './contracts.js';

/**
 * Sprint 8 — metric contracts in a standalone leaf module.
 *
 * Kept separate from `contracts.ts`/`metrics.ts`/`service.ts` so that the
 * metric type surface has no module-load-order coupling with the service or
 * the in-memory sink implementation that both depend on it.
 */

/** Aggregated, secret-free observability counters (prompt §20). */
export interface OrchestrationMemoryMetricsSnapshot {
  readonly retrievalCount: number;
  readonly retrievalSuccess: number;
  readonly retrievalFailure: number;
  readonly emptyRetrievals: number;
  readonly authorizationDenials: number;
  readonly contextRecordsSupplied: number;
  readonly contextTruncations: number;
  readonly retrievalDurationMs: number;
  readonly contextIntegrationDurationMs: number;
  readonly memoryUnavailableCount: number;
  readonly statusCounts: Readonly<Partial<Record<MemoryContextStatus, number>>>;
}

/** Injectable counter sink for orchestration memory metrics. */
export interface OrchestrationMemoryMetricSink {
  snapshot(): OrchestrationMemoryMetricsSnapshot;
  recordRetrievalStarted(): void;
  recordRetrievalSuccess(recordCount: number, durationMs: number): void;
  recordRetrievalFailure(): void;
  recordEmptyRetrieval(): void;
  recordAuthorizationDenial(): void;
  recordContextSupplied(recordCount: number): void;
  recordContextTruncation(): void;
  recordContextDuration(durationMs: number): void;
  recordUnavailable(): void;
  recordStatus(status: MemoryContextStatus): void;
}
