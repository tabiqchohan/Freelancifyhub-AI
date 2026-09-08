/**
 * Sprint 23 — Marketplace AI Team v1. Deterministic metrics.
 *
 * Lightweight counters/gauges for the marketplace-AI service. All numbers are
 * locally aggregated; nothing sensitive is ever stored. `insufficientData`
 * (Sprint 23 §28) is reported whenever a marketplace capability honestly
 * reports it cannot derive an observation from the supplied data.
 */

/** Counter snapshot for the marketplace-AI team. */
export interface MarketplaceAICounters {
  readonly requests: number;
  readonly completions: number;
  readonly partialCompletions: number;
  readonly failures: number;
  readonly cancellations: number;
  readonly timeouts: number;
  readonly agentExecutions: number;
  readonly agentFailures: number;
  readonly toolCalls: number;
  readonly toolFailures: number;
  readonly memoryRetrievals: number;
  readonly knowledgeRetrievals: number;
  readonly coordinationRuns: number;
  readonly coordinationFailures: number;
  readonly agenticRuns: number;
  readonly agenticFailures: number;
  readonly insufficientData: number;
  readonly latentLatencyMs: number;
}

/** Gauge snapshot for the marketplace-AI team. */
export interface MarketplaceAIGauges {
  readonly activeWorkflows: number;
  readonly workflowIds: number;
  readonly agentIds: number;
}

/** Full metrics snapshot. */
export interface MarketplaceAIMetricsSnapshot {
  readonly counters: MarketplaceAICounters;
  readonly gauges: MarketplaceAIGauges;
  readonly averageLatencyMs: number;
}

/** Deterministic metrics for the marketplace-AI service. */
export class MarketplaceAIMetrics {
  readonly name = 'marketplace-ai-metrics';

  private requests = 0;
  private completions = 0;
  private partialCompletions = 0;
  private failures = 0;
  private cancellations = 0;
  private timeouts = 0;
  private agentExecutions = 0;
  private agentFailures = 0;
  private toolCalls = 0;
  private toolFailures = 0;
  private memoryRetrievals = 0;
  private knowledgeRetrievals = 0;
  private coordinationRuns = 0;
  private coordinationFailures = 0;
  private agenticRuns = 0;
  private agenticFailures = 0;
  private insufficientData = 0;
  private latencyMsAccumulator = 0;
  private activeWorkflows = 0;
  private workflowIds = 0;
  private agentIds = 0;

  recordStarted(): void {
    this.requests += 1;
    this.activeWorkflows += 1;
  }

  recordCompleted(durationMs: number): void {
    this.completions += 1;
    this.activeWorkflows = Math.max(0, this.activeWorkflows - 1);
    this.latencyMsAccumulator += durationMs;
  }

  recordPartial(durationMs: number): void {
    this.partialCompletions += 1;
    this.activeWorkflows = Math.max(0, this.activeWorkflows - 1);
    this.latencyMsAccumulator += durationMs;
  }

  recordFailed(durationMs: number): void {
    this.failures += 1;
    this.activeWorkflows = Math.max(0, this.activeWorkflows - 1);
    this.latencyMsAccumulator += durationMs;
  }

  recordCancelled(): void {
    this.cancellations += 1;
  }

  recordTimeout(): void {
    this.timeouts += 1;
  }

  recordAgentExecution(): void {
    this.agentExecutions += 1;
  }

  recordAgentFailure(): void {
    this.agentFailures += 1;
  }

  recordToolCall(success: boolean): void {
    this.toolCalls += 1;
    if (!success) {
      this.toolFailures += 1;
    }
  }

  recordMemoryRetrieval(): void {
    this.memoryRetrievals += 1;
  }

  recordKnowledgeRetrieval(): void {
    this.knowledgeRetrievals += 1;
  }

  recordCoordination(): void {
    this.coordinationRuns += 1;
  }

  recordCoordinationFailure(): void {
    this.coordinationFailures += 1;
  }

  recordAgenticRun(success: boolean): void {
    this.agenticRuns += 1;
    if (!success) {
      this.agenticFailures += 1;
    }
  }

  /** Records a capability that honestly reported insufficient data (§28). */
  recordInsufficientData(): void {
    this.insufficientData += 1;
  }

  setWorld(world: { readonly workflowIds: number; readonly agentIds: number }): void {
    this.workflowIds = world.workflowIds;
    this.agentIds = world.agentIds;
  }

  /** Deterministic snapshot. */
  snapshot(): MarketplaceAIMetricsSnapshot {
    const completed = this.completions + this.partialCompletions + this.failures;
    return Object.freeze({
      counters: Object.freeze({
        requests: this.requests,
        completions: this.completions,
        partialCompletions: this.partialCompletions,
        failures: this.failures,
        cancellations: this.cancellations,
        timeouts: this.timeouts,
        agentExecutions: this.agentExecutions,
        agentFailures: this.agentFailures,
        toolCalls: this.toolCalls,
        toolFailures: this.toolFailures,
        memoryRetrievals: this.memoryRetrievals,
        knowledgeRetrievals: this.knowledgeRetrievals,
        coordinationRuns: this.coordinationRuns,
        coordinationFailures: this.coordinationFailures,
        agenticRuns: this.agenticRuns,
        agenticFailures: this.agenticFailures,
        insufficientData: this.insufficientData,
        latentLatencyMs: this.latencyMsAccumulator,
      }),
      gauges: Object.freeze({
        activeWorkflows: this.activeWorkflows,
        workflowIds: this.workflowIds,
        agentIds: this.agentIds,
      }),
      averageLatencyMs: completed > 0 ? Math.round(this.latencyMsAccumulator / completed) : 0,
    });
  }
}
