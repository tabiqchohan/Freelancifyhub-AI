import { describe, expect, it } from 'vitest';

import { AggregationStatus } from '../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import { AiosMetrics } from '../../../src/ai-operating-system/metrics.js';

describe('AIOS metrics (Sprint 26)', () => {
  it('records points, statuses and durations into the snapshot', () => {
    const metrics = new AiosMetrics();
    metrics.recordPoint('intent.project.create');
    metrics.recordStatus(AggregationStatus.Success);
    metrics.recordDuration('duration.client', 500);

    const snapshot = metrics.snapshot();
    expect(snapshot.counters['intent.project.create']).toBe(1);
    expect(snapshot.counters['request.status.SUCCESS']).toBe(1);
    expect(snapshot.counters['request.status.all']).toBe(1);
    expect(snapshot.durationsMs['duration.client']).toBe(500);
    expect(snapshot.since).toEqual(expect.any(String));
  });

  it('derives statusCounts over the fixed status vocabulary', () => {
    const metrics = new AiosMetrics();
    metrics.recordStatus(AggregationStatus.Partial);
    metrics.recordStatus(AggregationStatus.Failed);
    metrics.recordStatus(AggregationStatus.Success);
    expect(metrics.statusCounts()).toEqual({
      SUCCESS: 1,
      PARTIAL: 1,
      FAILED: 1,
      CANCELLED: 0,
      TIMED_OUT: 0,
    });
  });

  it('projects intents without the label prefix', () => {
    const metrics = new AiosMetrics();
    metrics.recordPoint('intent.project.create');
    metrics.recordPoint('intent.project.create');
    metrics.recordPoint('target.admin');
    expect(metrics.intents()).toEqual({ 'project.create': 2 });
    expect(metrics.targets()).toEqual({ admin: 1 });
  });

  it('supports label-prefixed snapshots and average duration rounding', () => {
    const metrics = new AiosMetrics();
    metrics.recordPoint('intent.a');
    metrics.recordPoint('target.b');
    metrics.recordDuration('duration.client', 100);
    metrics.recordDuration('duration.client', 150);
    const prefixed = metrics.snapshot('intent.');
    expect(Object.keys(prefixed.counters)).toEqual(['intent.a']);
    expect(prefixed.durationsMs['duration.client']).toBeUndefined();
    const full = metrics.snapshot();
    expect(full.durationsMs['duration.client']).toBe(125);
  });
});
