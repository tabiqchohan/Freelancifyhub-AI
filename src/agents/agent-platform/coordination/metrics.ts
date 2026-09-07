/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Deterministic metrics.
 *
 * In-memory aggregates: counters + gauges. Never contains secrets, prompts,
 * tool arguments, or personal data. The interface stays extensible for future
 * durable persistence (Sprint 20 §27).
 */

/** Mutable counters (never exposed directly). */
interface MutableCounters {
  totalCoordinations: number;
  successfulCoordinations: number;
  failedCoordinations: number;
  cancelledCoordinations: number;
  taskCount: number;
  taskSuccesses: number;
  taskFailures: number;
  retries: number;
  taskLatencyMs: number;
  coordinationLatencyMs: number;
  conflicts: number;
  agentRejections: number;
  timeouts: number;
}

/** Mutable gauges. */
interface MutableGauges {
  activeCoordinations: number;
  /** Peak concurrent coordinations observed. */
  peakActiveCoordinations: number;
}

/** Read-only counters snapshot. */
export interface CoordinationCounters {
  readonly totalCoordinations: number;
  readonly successfulCoordinations: number;
  readonly failedCoordinations: number;
  readonly cancelledCoordinations: number;
  readonly taskCount: number;
  readonly taskSuccesses: number;
  readonly taskFailures: number;
  readonly retries: number;
  readonly taskLatencyMs: number;
  readonly coordinationLatencyMs: number;
  readonly conflicts: number;
  readonly agentRejections: number;
  readonly timeouts: number;
}

/** Read-only gauges snapshot. */
export interface CoordinationGauges {
  readonly activeCoordinations: number;
  readonly peakActiveCoordinations: number;
}

/** Full coordination metrics snapshot. */
export interface CoordinationMetricsSnapshot {
  readonly counts: CoordinationCounters;
  readonly gauges: CoordinationGauges;
}

/** Deterministic in-process accumulator for coordination metrics. */
export class CoordinationMetrics {
  readonly name = 'coordination-metrics';

  private readonly counts: MutableCounters = emptyCounters();
  private readonly gauges: MutableGauges = emptyGauges();

  // --- coordinations --------------------------------------------------------

  recordCoordinationStarted(): void {
    this.counts.totalCoordinations += 1;
    this.gauges.activeCoordinations += 1;
    this.gauges.peakActiveCoordinations = Math.max(
      this.gauges.peakActiveCoordinations,
      this.gauges.activeCoordinations,
    );
  }

  recordCoordinationCompleted(
    status: 'success' | 'failed' | 'cancelled',
    durationMs: number,
  ): void {
    if (status === 'success') {
      this.counts.successfulCoordinations += 1;
    } else if (status === 'failed') {
      this.counts.failedCoordinations += 1;
    } else {
      this.counts.cancelledCoordinations += 1;
    }
    this.counts.coordinationLatencyMs += Math.max(0, Math.floor(durationMs));
    this.gauges.activeCoordinations = Math.max(0, this.gauges.activeCoordinations - 1);
  }

  // --- tasks ----------------------------------------------------------------

  recordTaskStarted(): void {
    this.counts.taskCount += 1;
  }

  recordTaskCompleted(success: boolean, durationMs: number): void {
    if (success) {
      this.counts.taskSuccesses += 1;
    } else {
      this.counts.taskFailures += 1;
    }
    this.counts.taskLatencyMs += Math.max(0, Math.floor(durationMs));
  }

  recordRetry(): void {
    this.counts.retries += 1;
  }

  recordTimeout(): void {
    this.counts.timeouts += 1;
  }

  // --- policy ----------------------------------------------------------------

  recordConflict(): void {
    this.counts.conflicts += 1;
  }

  recordAgentRejection(): void {
    this.counts.agentRejections += 1;
  }

  snapshot(): CoordinationMetricsSnapshot {
    return Object.freeze({
      counts: Object.freeze({ ...this.counts }),
      gauges: Object.freeze({ ...this.gauges }),
    });
  }
}

function emptyCounters(): MutableCounters {
  return {
    totalCoordinations: 0,
    successfulCoordinations: 0,
    failedCoordinations: 0,
    cancelledCoordinations: 0,
    taskCount: 0,
    taskSuccesses: 0,
    taskFailures: 0,
    retries: 0,
    taskLatencyMs: 0,
    coordinationLatencyMs: 0,
    conflicts: 0,
    agentRejections: 0,
    timeouts: 0,
  };
}

function emptyGauges(): MutableGauges {
  return {
    activeCoordinations: 0,
    peakActiveCoordinations: 0,
  };
}
