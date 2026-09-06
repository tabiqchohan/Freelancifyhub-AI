/**
 * Sprint 18 — Agentic Tool-Calling. Deterministic in-process metrics.
 *
 * Safe aggregates: only counts, durations, and LLM token sums. Never
 * contains raw prompts, responses, tool arguments, secrets, or personal data.
 */

/** Mutable counters held per operation (never exposed directly). */
interface MutableMetrics {
  operations: number;
  turns: number;
  toolCalls: number;
  toolCallSuccesses: number;
  toolCallFailures: number;
  toolCallRejections: number;
  reasoningCalls: number;
  cancellations: number;
  timeouts: number;
  limitReached: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalDurationMs: number;
}

/** Read-only snapshot of the aggregated counters. */
export interface AgenticMetricCounters {
  readonly operations: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly toolCallSuccesses: number;
  readonly toolCallFailures: number;
  readonly toolCallRejections: number;
  readonly reasoningCalls: number;
  readonly cancellations: number;
  readonly timeouts: number;
  readonly limitReached: number;
  readonly failures: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** Full metrics snapshot. */
export interface AgenticMetricsSnapshot {
  readonly totals: AgenticMetricCounters;
  readonly totalDurationMs: number;
}

/** Deterministic, in-process agentic metrics accumulator. */
export class AgenticLoopMetrics {
  readonly name = 'agentic-loop-metrics';

  private readonly totals: MutableMetrics = emptyCounters();

  /** Records a completed agentic operation. */
  record(input: {
    readonly turns: number;
    readonly toolCalls: number;
    readonly toolCallSuccesses: number;
    readonly toolCallFailures: number;
    readonly toolCallRejections: number;
    readonly reasoningCalls: number;
    readonly outcome: 'success' | 'failure' | 'cancelled' | 'timeout' | 'limit';
    readonly durationMs: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  }): void {
    this.totals.operations += 1;
    this.totals.turns += input.turns;
    this.totals.toolCalls += input.toolCalls;
    this.totals.toolCallSuccesses += input.toolCallSuccesses;
    this.totals.toolCallFailures += input.toolCallFailures;
    this.totals.toolCallRejections += input.toolCallRejections;
    this.totals.reasoningCalls += input.reasoningCalls;
    this.totals.totalDurationMs += input.durationMs;
    this.totals.inputTokens += input.inputTokens ?? 0;
    this.totals.outputTokens += input.outputTokens ?? 0;
    this.totals.totalTokens += input.totalTokens ?? 0;
    switch (input.outcome) {
      case 'cancelled':
        this.totals.cancellations += 1;
        break;
      case 'timeout':
        this.totals.timeouts += 1;
        break;
      case 'limit':
        this.totals.limitReached += 1;
        break;
      case 'failure':
        this.totals.failures += 1;
        break;
      default:
        break;
    }
  }

  snapshot(): AgenticMetricsSnapshot {
    return {
      totals: freezeCounters(this.totals),
      totalDurationMs: this.totals.totalDurationMs,
    };
  }
}

function emptyCounters(): MutableMetrics {
  return {
    operations: 0,
    turns: 0,
    toolCalls: 0,
    toolCallSuccesses: 0,
    toolCallFailures: 0,
    toolCallRejections: 0,
    reasoningCalls: 0,
    cancellations: 0,
    timeouts: 0,
    limitReached: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalDurationMs: 0,
  };
}

function freezeCounters(c: MutableMetrics): AgenticMetricCounters {
  return Object.freeze({ ...c });
}
