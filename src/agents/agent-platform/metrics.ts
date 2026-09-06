/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. Deterministic metrics.
 *
 * Safe aggregates: counters, gauges, durations. Never contains secrets,
 * prompts, tool arguments, or personal data.
 */

/** Mutable counters held internally (never exposed directly). */
interface MutableCounters {
  lifecycleTransitions: number;
  executionStarts: number;
  executionCompletions: number;
  rejectedExecutions: number;
  capabilityDenials: number;
  permissionDenials: number;
  toolDenials: number;
  executionLimitDenials: number;
  totalExecutionMs: number;
  peakActiveExecutions: number;
}

/** Mutable gauges (sample of the lifecycle at snapshot time). */
interface MutableGauges {
  registered: number;
  ready: number;
  running: number;
  paused: number;
  draining: number;
  disabled: number;
  failed: number;
  terminated: number;
  activeExecutions: number;
}

/** Read-only counters snapshot. */
export interface AgentPlatformCounters {
  readonly lifecycleTransitions: number;
  readonly executionStarts: number;
  readonly executionCompletions: number;
  readonly rejectedExecutions: number;
  readonly capabilityDenials: number;
  readonly permissionDenials: number;
  readonly toolDenials: number;
  readonly executionLimitDenials: number;
  readonly totalExecutionMs: number;
  readonly peakActiveExecutions: number;
}

/** Read-only gauge snapshot. */
export interface AgentPlatformGauges {
  readonly registered: number;
  readonly ready: number;
  readonly running: number;
  readonly paused: number;
  readonly draining: number;
  readonly disabled: number;
  readonly failed: number;
  readonly terminated: number;
  readonly activeExecutions: number;
}

/** Full platform metrics snapshot. */
export interface AgentPlatformMetricsSnapshot {
  readonly counts: AgentPlatformCounters;
  readonly gauges: AgentPlatformGauges;
}

/** A lifecycle-count sample supplied by the gateway at snapshot time. */
export interface AgentLifecycleCounts {
  readonly registered: number;
  readonly ready: number;
  readonly running: number;
  readonly paused: number;
  readonly draining: number;
  readonly disabled: number;
  readonly failed: number;
  readonly terminated: number;
  readonly activeExecutions: number;
}

/** Deterministic in-process accumulator for platform metrics. */
export class AgentPlatformMetrics {
  readonly name = 'agent-platform-metrics';

  private readonly counts: MutableCounters = emptyCounters();
  private readonly gauges: MutableGauges = emptyGauges();

  // --- counters ------------------------------------------------------------

  recordLifecycleTransition(): void {
    this.counts.lifecycleTransitions += 1;
  }

  recordRejectedExecution(): void {
    this.counts.rejectedExecutions += 1;
  }

  recordCapabilityDenial(): void {
    this.counts.capabilityDenials += 1;
  }

  recordPermissionDenial(): void {
    this.counts.permissionDenials += 1;
  }

  recordToolDenial(): void {
    this.counts.toolDenials += 1;
  }

  recordExecutionLimitDenial(): void {
    this.counts.executionLimitDenials += 1;
  }

  // --- gauges --------------------------------------------------------------

  setAgentCounts(counts: AgentLifecycleCounts): void {
    this.gauges.registered = counts.registered;
    this.gauges.ready = counts.ready;
    this.gauges.running = counts.running;
    this.gauges.paused = counts.paused;
    this.gauges.draining = counts.draining;
    this.gauges.disabled = counts.disabled;
    this.gauges.failed = counts.failed;
    this.gauges.terminated = counts.terminated;
    this.gauges.activeExecutions = counts.activeExecutions;
  }

  // --- executions ----------------------------------------------------------

  recordExecutionStarted(activeExecutions: number): void {
    this.counts.executionStarts += 1;
    this.counts.peakActiveExecutions = Math.max(this.counts.peakActiveExecutions, activeExecutions);
  }

  recordExecutionCompleted(durationMs: number): void {
    this.counts.executionCompletions += 1;
    this.counts.totalExecutionMs += Math.max(0, Math.floor(durationMs));
  }

  snapshot(): AgentPlatformMetricsSnapshot {
    return Object.freeze({
      counts: Object.freeze({ ...this.counts }),
      gauges: Object.freeze({ ...this.gauges }),
    });
  }
}

function emptyCounters(): MutableCounters {
  return {
    lifecycleTransitions: 0,
    executionStarts: 0,
    executionCompletions: 0,
    rejectedExecutions: 0,
    capabilityDenials: 0,
    permissionDenials: 0,
    toolDenials: 0,
    executionLimitDenials: 0,
    totalExecutionMs: 0,
    peakActiveExecutions: 0,
  };
}

function emptyGauges(): MutableGauges {
  return {
    registered: 0,
    ready: 0,
    running: 0,
    paused: 0,
    draining: 0,
    disabled: 0,
    failed: 0,
    terminated: 0,
    activeExecutions: 0,
  };
}
