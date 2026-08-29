import type { MemoryContextStatus } from './contracts.js';
import type {
  OrchestrationMemoryMetricsSnapshot,
  OrchestrationMemoryMetricSink,
} from './metrics-types.js';

export type { OrchestrationMemoryMetricsSnapshot, OrchestrationMemoryMetricSink };

/**
 * Sprint 8 â€” safe, aggregated observability (prompt Â§20).
 *
 * Counters only. Never stores memory contents, passwords, API keys, tokens,
 * credentials, or raw sensitive metadata.
 */

/** Default in-memory metric sink (aggregate counters only). */
export class InMemoryOrchestrationMetrics implements OrchestrationMemoryMetricSink {
  private retrievalCount = 0;
  private retrievalSuccess = 0;
  private retrievalFailure = 0;
  private emptyRetrievals = 0;
  private authorizationDenials = 0;
  private contextRecordsSupplied = 0;
  private contextTruncations = 0;
  private retrievalDurationMs = 0;
  private contextIntegrationDurationMs = 0;
  private memoryUnavailableCount = 0;
  private readonly statusCounts = new Map<MemoryContextStatus, number>();

  snapshot(): OrchestrationMemoryMetricsSnapshot {
    return {
      retrievalCount: this.retrievalCount,
      retrievalSuccess: this.retrievalSuccess,
      retrievalFailure: this.retrievalFailure,
      emptyRetrievals: this.emptyRetrievals,
      authorizationDenials: this.authorizationDenials,
      contextRecordsSupplied: this.contextRecordsSupplied,
      contextTruncations: this.contextTruncations,
      retrievalDurationMs: this.retrievalDurationMs,
      contextIntegrationDurationMs: this.contextIntegrationDurationMs,
      memoryUnavailableCount: this.memoryUnavailableCount,
      statusCounts: Object.fromEntries(this.statusCounts) as Partial<
        Record<MemoryContextStatus, number>
      >,
    };
  }

  recordRetrievalStarted(): void {
    this.retrievalCount += 1;
  }

  recordRetrievalSuccess(recordCount: number, durationMs: number): void {
    this.retrievalSuccess += 1;
    this.retrievalDurationMs += durationMs;
    if (recordCount === 0) this.emptyRetrievals += 1;
  }

  recordRetrievalFailure(): void {
    this.retrievalFailure += 1;
  }

  recordEmptyRetrieval(): void {
    this.emptyRetrievals += 1;
  }

  recordAuthorizationDenial(): void {
    this.authorizationDenials += 1;
  }

  recordContextSupplied(recordCount: number): void {
    this.contextRecordsSupplied += recordCount;
  }

  recordContextTruncation(): void {
    this.contextTruncations += 1;
  }

  recordContextDuration(durationMs: number): void {
    this.contextIntegrationDurationMs += durationMs;
  }

  recordUnavailable(): void {
    this.memoryUnavailableCount += 1;
  }

  recordStatus(status: MemoryContextStatus): void {
    this.statusCounts.set(status, (this.statusCounts.get(status) ?? 0) + 1);
  }
}
