import { describe, expect, it } from 'vitest';

import { ToolMetrics, ToolResultStatus } from '../../../../src/agents/ag-004-tool-manager/index.js';

describe('AG-004 Tool Metrics', () => {
  it('starts empty', () => {
    const m = new ToolMetrics();
    const snap = m.snapshot();
    expect(snap.totals.executions).toBe(0);
  });

  it('records outcomes into per-tool counters', () => {
    const m = new ToolMetrics();
    m.record('tool:calc:v1.0.0', ToolResultStatus.Success, 10);
    m.record('tool:calc:v1.0.0', ToolResultStatus.Success, 20);
    m.record('tool:calc:v1.0.0', ToolResultStatus.Timeout, 500);
    m.record('tool:other:v1.0.0', ToolResultStatus.ValidationFailed, 1);

    const snap = m.snapshot();
    expect(snap.totals.executions).toBe(4);
    expect(snap.totals.successes).toBe(2);
    expect(snap.totals.timeouts).toBe(1);
    expect(snap.totals.validationFailures).toBe(1);
    const calc = snap.byTool['tool:calc:v1.0.0'];
    expect(calc?.counters.successes).toBe(2);
    expect(calc?.counters.timeouts).toBe(1);
    expect(calc?.totalDurationMs).toBe(530);
  });

  it('maps authorization failure counter', () => {
    const m = new ToolMetrics();
    m.record('t', ToolResultStatus.AuthorizationFailed, 2);
    m.record('t', ToolResultStatus.Cancelled, 3);
    m.record('t', ToolResultStatus.ExecutionFailed, 4);
    const snap = m.snapshot();
    expect(snap.totals.authFailures).toBe(1);
    expect(snap.totals.cancellations).toBe(1);
    expect(snap.totals.failures).toBe(1);
  });

  it('returns deterministic ordering of byTool keys', () => {
    const m = new ToolMetrics();
    m.record('z', ToolResultStatus.Success, 1);
    m.record('a', ToolResultStatus.Success, 1);
    expect(Object.keys(m.snapshot().byTool)).toEqual(['a', 'z']);
  });
});
