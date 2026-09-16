/**
 * Sprint 26 — AIOS operational metrics.
 *
 * Lightweight, label-based counters/gauges kept only at the AIOS boundary.
 * They feed the /healthz `aiOperatingSystem` block and the status snapshots.
 */

export interface AiosMetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly durationsMs: Readonly<Record<string, number>>;
  readonly since: string;
}

const STATUS_LABELS = ['SUCCESS', 'PARTIAL', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;

/** A single recorded latency aggregate (sum + count for mean). */
interface DurationAggregate {
  readonly totalMs: number;
  readonly count: number;
}

export class AiosMetrics {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, DurationAggregate>();
  private readonly since = new Date().toISOString();

  recordPoint(label: string, delta = 1): void {
    this.counters.set(label, (this.counters.get(label) ?? 0) + delta);
    if (label.startsWith('request.status.')) {
      this.counters.set(
        'request.status.all',
        (this.counters.get('request.status.all') ?? 0) + delta,
      );
    }
  }

  recordStatus(status: string): void {
    this.recordPoint(`request.status.${status}`);
  }

  recordDuration(label: string, ms: number): void {
    const current = this.durations.get(label);
    this.durations.set(label, {
      totalMs: (current?.totalMs ?? 0) + Math.max(0, ms),
      count: (current?.count ?? 0) + 1,
    });
  }

  snapshot(prefix?: string): AiosMetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [key, value] of this.counters) {
      if (prefix === undefined || key.startsWith(prefix)) {
        counters[key] = value;
      }
    }
    const durationsMs: Record<string, number> = {};
    for (const [key, value] of this.durations) {
      if (prefix === undefined || key.startsWith(prefix)) {
        durationsMs[key] = value.count > 0 ? Math.round(value.totalMs / value.count) : 0;
      }
    }
    return { counters, durationsMs, since: this.since };
  }

  statusCounts(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const status of STATUS_LABELS) {
      counts[status] = this.counters.get(`request.status.${status}`) ?? 0;
    }
    return counts;
  }

  intents(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const [key, value] of this.counters) {
      if (key.startsWith('intent.')) {
        counts[key.replace('intent.', '')] = value;
      }
    }
    return counts;
  }

  targets(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const [key, value] of this.counters) {
      if (key.startsWith('target.')) {
        counts[key.replace('target.', '')] = value;
      }
    }
    return counts;
  }
}
