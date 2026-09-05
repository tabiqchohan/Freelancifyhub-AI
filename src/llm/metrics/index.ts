/**
 * Sprint 17 — LLM / reasoning metrics.
 *
 * Deterministic in-process metrics following the AG-004 ToolMetrics pattern.
 * Never contains sensitive payloads — only counts, durations, retry counts,
 * and token aggregates.
 */

/** Per-provider metric counters (readonly snapshot). */
export interface LLMMetricCounters {
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
  readonly timeouts: number;
  readonly cancellations: number;
  readonly retries: number;
  readonly authFailures: number;
  readonly validationFailures: number;
  readonly rateLimits: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A single metric sample (aggregate, safe). */
export interface LLMMetricSnapshot {
  readonly providerId: string;
  readonly model: string;
  readonly counters: LLMMetricCounters;
  readonly totalDurationMs: number;
  readonly lastDurationMs?: number;
}

/** Overall metrics snapshot. */
export interface LLMMetricsSnapshot {
  readonly totals: LLMMetricCounters;
  readonly byProvider: Readonly<Record<string, LLMMetricSnapshot>>;
}

/** Mutable internal counters (never exposed). */
interface MutableCounters {
  requests: number;
  successes: number;
  failures: number;
  timeouts: number;
  cancellations: number;
  retries: number;
  authFailures: number;
  validationFailures: number;
  rateLimits: number;
  inputTokens: number;
  outputTokens: number;
}

interface MutableSnapshot {
  providerId: string;
  model: string;
  counters: MutableCounters;
  totalDurationMs: number;
  lastDurationMs?: number;
}

function emptyCounters(): MutableCounters {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    cancellations: 0,
    retries: 0,
    authFailures: 0,
    validationFailures: 0,
    rateLimits: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function freezeCounters(c: MutableCounters): LLMMetricCounters {
  return Object.freeze({ ...c });
}

/** Outcome classification for a single generation attempt group. */
export type LLMOutcomeClass =
  | 'success'
  | 'timeout'
  | 'cancelled'
  | 'rate_limit'
  | 'validation_failure'
  | 'auth_failure'
  | 'failure';

/** Per-request metrics recorded for one reasoning call. */
export interface LLMMetricsRecordInput {
  readonly providerId: string;
  readonly model: string;
  readonly outcome: LLMOutcomeClass;
  readonly durationMs: number;
  readonly retries?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Deterministic in-process LLM metrics accumulator. */
export class LLMMetrics {
  readonly name = 'llm-metrics';

  private readonly byProvider = new Map<string, MutableSnapshot>();

  /** Records a completed reasoning call outcome. */
  record(input: LLMMetricsRecordInput): void {
    const key = input.providerId;
    const current = this.byProvider.get(key) ?? {
      providerId: input.providerId,
      model: input.model,
      counters: emptyCounters(),
      totalDurationMs: 0,
    };

    current.counters.requests += 1;
    current.totalDurationMs += input.durationMs;
    current.lastDurationMs = input.durationMs;
    current.counters.retries += input.retries ?? 0;
    current.counters.inputTokens += input.inputTokens ?? 0;
    current.counters.outputTokens += input.outputTokens ?? 0;

    switch (input.outcome) {
      case 'success':
        current.counters.successes += 1;
        break;
      case 'timeout':
        current.counters.timeouts += 1;
        break;
      case 'cancelled':
        current.counters.cancellations += 1;
        break;
      case 'rate_limit':
        current.counters.rateLimits += 1;
        current.counters.failures += 1;
        break;
      case 'validation_failure':
        current.counters.validationFailures += 1;
        current.counters.failures += 1;
        break;
      case 'auth_failure':
        current.counters.authFailures += 1;
        current.counters.failures += 1;
        break;
      default:
        current.counters.failures += 1;
        break;
    }

    this.byProvider.set(key, current);
  }

  /** Returns a deterministic, aggregate snapshot. */
  snapshot(): LLMMetricsSnapshot {
    const totals: MutableCounters = emptyCounters();
    const byProvider: Record<string, LLMMetricSnapshot> = {};

    const providerIds = [...this.byProvider.keys()].sort();
    for (const providerId of providerIds) {
      const entry = this.byProvider.get(providerId);
      if (entry === undefined) {
        continue;
      }
      byProvider[providerId] = {
        providerId,
        model: entry.model,
        counters: freezeCounters(entry.counters),
        totalDurationMs: entry.totalDurationMs,
        lastDurationMs: entry.lastDurationMs,
      };
      totals.requests += entry.counters.requests;
      totals.successes += entry.counters.successes;
      totals.failures += entry.counters.failures;
      totals.timeouts += entry.counters.timeouts;
      totals.cancellations += entry.counters.cancellations;
      totals.retries += entry.counters.retries;
      totals.authFailures += entry.counters.authFailures;
      totals.validationFailures += entry.counters.validationFailures;
      totals.rateLimits += entry.counters.rateLimits;
      totals.inputTokens += entry.counters.inputTokens;
      totals.outputTokens += entry.counters.outputTokens;
    }

    return { totals: freezeCounters(totals), byProvider };
  }
}
