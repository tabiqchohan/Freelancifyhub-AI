import { ToolResultStatus } from '../enums/index.js';

/**
 * Deterministic in-process tool metrics. Never contains sensitive payloads —
 * only counts, durations, and per-tool aggregates.
 */

/** Per-tool metric counters (readonly snapshot). */
export interface ToolMetricCounters {
  readonly executions: number;
  readonly successes: number;
  readonly failures: number;
  readonly timeouts: number;
  readonly cancellations: number;
  readonly authFailures: number;
  readonly validationFailures: number;
}

/** A single metric sample (aggregate, safe). */
export interface ToolMetricSnapshot {
  readonly toolId: string;
  readonly counters: ToolMetricCounters;
  readonly totalDurationMs: number;
  readonly lastDurationMs?: number;
}

/** Overall metrics snapshot. */
export interface ToolMetricsSnapshot {
  readonly totals: ToolMetricCounters;
  readonly totalDurationMs: number;
  readonly byTool: Readonly<Record<string, ToolMetricSnapshot>>;
}

/** Mutable internal counters (never exposed). */
interface MutableCounters {
  executions: number;
  successes: number;
  failures: number;
  timeouts: number;
  cancellations: number;
  authFailures: number;
  validationFailures: number;
}

interface MutableSnapshot {
  toolId: string;
  counters: MutableCounters;
  totalDurationMs: number;
  lastDurationMs?: number;
}

function emptyCounters(): MutableCounters {
  return {
    executions: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    cancellations: 0,
    authFailures: 0,
    validationFailures: 0,
  };
}

function freezeCounters(c: MutableCounters): ToolMetricCounters {
  return Object.freeze({ ...c });
}

/** Deterministic in-process tool metrics accumulator. */
export class ToolMetrics {
  readonly name = 'tool-metrics';

  private readonly byTool = new Map<string, MutableSnapshot>();

  /** Records a completed execution outcome. */
  record(toolId: string, status: ToolResultStatus, durationMs: number): void {
    const current = this.byTool.get(toolId) ?? {
      toolId,
      counters: emptyCounters(),
      totalDurationMs: 0,
    };

    current.counters.executions += 1;
    current.totalDurationMs += durationMs;
    current.lastDurationMs = durationMs;

    switch (status) {
      case ToolResultStatus.Success:
        current.counters.successes += 1;
        break;
      case ToolResultStatus.Timeout:
        current.counters.timeouts += 1;
        break;
      case ToolResultStatus.Cancelled:
        current.counters.cancellations += 1;
        break;
      case ToolResultStatus.AuthorizationFailed:
        current.counters.authFailures += 1;
        break;
      case ToolResultStatus.ValidationFailed:
        current.counters.validationFailures += 1;
        break;
      default:
        current.counters.failures += 1;
        break;
    }

    this.byTool.set(toolId, current);
  }

  /** Returns a deterministic, aggregate snapshot. */
  snapshot(): ToolMetricsSnapshot {
    const totals: MutableCounters = emptyCounters();
    let totalDurationMs = 0;
    const byTool: Record<string, ToolMetricSnapshot> = {};

    const toolIds = [...this.byTool.keys()].sort();
    for (const toolId of toolIds) {
      const entry = this.byTool.get(toolId);
      if (entry === undefined) {
        continue;
      }
      byTool[toolId] = {
        toolId,
        counters: freezeCounters(entry.counters),
        totalDurationMs: entry.totalDurationMs,
        lastDurationMs: entry.lastDurationMs,
      };
      totals.executions += entry.counters.executions;
      totals.successes += entry.counters.successes;
      totals.failures += entry.counters.failures;
      totals.timeouts += entry.counters.timeouts;
      totals.cancellations += entry.counters.cancellations;
      totals.authFailures += entry.counters.authFailures;
      totals.validationFailures += entry.counters.validationFailures;
      totalDurationMs += entry.totalDurationMs;
    }

    return { totals: freezeCounters(totals), totalDurationMs, byTool };
  }
}
