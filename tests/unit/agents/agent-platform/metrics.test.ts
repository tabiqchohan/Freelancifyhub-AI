import { describe, expect, it } from 'vitest';

import { AgentPlatformMetrics } from '../../../../src/agents/agent-platform/metrics.js';

describe('AgentPlatformMetrics', () => {
  it('starts empty', () => {
    const metrics = new AgentPlatformMetrics();
    const snap = metrics.snapshot();
    expect(snap.counts.lifecycleTransitions).toBe(0);
    expect(snap.gauges.registered).toBe(0);
    expect(snap.gauges.activeExecutions).toBe(0);
  });

  it('accumulates counters deterministically', () => {
    const metrics = new AgentPlatformMetrics();
    metrics.recordLifecycleTransition();
    metrics.recordLifecycleTransition();
    metrics.recordRejectedExecution();
    metrics.recordCapabilityDenial();
    metrics.recordPermissionDenial();
    metrics.recordToolDenial();
    metrics.recordExecutionLimitDenial();
    const snap = metrics.snapshot();
    expect(snap.counts.lifecycleTransitions).toBe(2);
    expect(snap.counts.rejectedExecutions).toBe(1);
    expect(snap.counts.capabilityDenials).toBe(1);
    expect(snap.counts.permissionDenials).toBe(1);
    expect(snap.counts.toolDenials).toBe(1);
    expect(snap.counts.executionLimitDenials).toBe(1);
  });

  it('tracks execution starts/completions and peak active', () => {
    const metrics = new AgentPlatformMetrics();
    metrics.recordExecutionStarted(1);
    metrics.recordExecutionStarted(2);
    metrics.recordExecutionCompleted(150.4);
    const snap = metrics.snapshot();
    expect(snap.counts.executionStarts).toBe(2);
    expect(snap.counts.executionCompletions).toBe(1);
    expect(snap.counts.totalExecutionMs).toBe(150);
    expect(snap.counts.peakActiveExecutions).toBe(2);
  });

  it('exposes read-only gauges from lifecycle counts', () => {
    const metrics = new AgentPlatformMetrics();
    metrics.setAgentCounts({
      registered: 2,
      ready: 1,
      running: 1,
      paused: 0,
      draining: 0,
      disabled: 0,
      failed: 0,
      terminated: 0,
      activeExecutions: 1,
    });
    const snap = metrics.snapshot();
    expect(snap.gauges.registered).toBe(2);
    expect(snap.gauges.ready).toBe(1);
    expect(snap.gauges.running).toBe(1);
    expect(snap.gauges.activeExecutions).toBe(1);
  });

  it('snapshot is immutable', () => {
    const metrics = new AgentPlatformMetrics();
    const snap = metrics.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.counts)).toBe(true);
    expect(Object.isFrozen(snap.gauges)).toBe(true);
  });
});
