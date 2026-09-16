import { describe, expect, it } from 'vitest';

import { AggregationStatus } from '../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import {
  normalizeExecutionResult,
  toAiosStatus,
} from '../../../src/ai-operating-system/execution-result.js';

const target = { kind: 'client' } as const;
const startedAtMs = Date.now();

describe('AIOS execution result normalization (Sprint 26)', () => {
  it('maps every team request status onto the shared vocabulary', () => {
    expect(toAiosStatus('COMPLETED')).toBe(AggregationStatus.Success);
    expect(toAiosStatus('COMPLETED_PARTIAL')).toBe(AggregationStatus.Partial);
    expect(toAiosStatus('CANCELLED')).toBe(AggregationStatus.Cancelled);
    expect(toAiosStatus('TIMED_OUT')).toBe(AggregationStatus.TimedOut);
    expect(toAiosStatus('FAILED')).toBe(AggregationStatus.Failed);
  });

  it('normalizes a team result envelope', () => {
    const result = normalizeExecutionResult(
      target,
      {
        status: 'COMPLETED',
        response: 'created',
        agents: ['AG-101'],
        confidence: 0.9,
        coordinationId: 'coo-1',
        coordinationStatus: 'COMPLETED',
      },
      startedAtMs,
    );
    expect(result.status).toBe(AggregationStatus.Success);
    expect(result.responseText).toBe('created');
    expect(result.agents).toEqual(['AG-101']);
    expect(result.confidence).toBe(0.9);
    expect(result.completedAtMs).toBeGreaterThanOrEqual(result.startedAtMs);
  });

  it('defaults a missing team status to FAILED', () => {
    const result = normalizeExecutionResult(
      target,
      { status: undefined, response: '' },
      startedAtMs,
    );
    expect(result.status).toBe(AggregationStatus.Failed);
  });

  it('normalizes an orchestrator tail response', () => {
    const result = normalizeExecutionResult(
      { kind: 'orchestrator' },
      {
        status: 'SUCCESS',
        intent: { primary: { intent: { id: 'platform.help' } } },
        execution: { stepResults: [{ agentId: 'AG-306' }] },
        aggregated: { outputs: [{ output: 'help text' }] },
      } as never,
      startedAtMs,
    );
    expect(result.status).toBe('SUCCESS');
    expect(result.responseText).toBe('help text');
    expect(result.agents).toEqual(['AG-306']);
  });
});
