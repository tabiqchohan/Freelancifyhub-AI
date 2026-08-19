import { describe, expect, it } from 'vitest';

import { SharedAggregationService } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/aggregators/index.js';
import { makeAggregationInput, makeExecutionResult, makeStepResult } from './fixtures.js';

/** Builds a deeply nested output containing secrets at the deepest leaf. */
function deepSecretOutput(depth: number): unknown {
  let leaf: unknown = {
    token: 'DEEP_TOP_SECRET_TOKEN',
    password: 'DEEP_TOP_SECRET_PWD',
  };
  for (let level = 0; level < depth; level += 1) {
    leaf = { nested: leaf };
  }
  return { data: leaf };
}

describe('Aggregation - H-7 security/stress coverage', () => {
  it('aggregates a large result set without leaking secrets', () => {
    const stepResults = Array.from({ length: 80 }, (_, index) =>
      makeStepResult({
        stepId: `step-${index + 1}`,
        order: index + 1,
        output: { apiKey: 'LARGE_SET_SECRET_1', nested: { credentials: 'LARGE_SET_SECRET_2' } },
      }),
    );

    const service = new SharedAggregationService();
    const response = service.aggregate(
      makeAggregationInput({ results: [makeExecutionResult({ stepResults })] }),
    );

    expect(response.outputs).toHaveLength(80);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('LARGE_SET_SECRET_1');
    expect(serialized).not.toContain('LARGE_SET_SECRET_2');
  });

  it('strips secrets nested at any depth inside outputs', () => {
    const stepResults = Array.from({ length: 5 }, (_, index) =>
      makeStepResult({
        stepId: `step-${index + 1}`,
        order: index + 1,
        output: deepSecretOutput(6),
      }),
    );

    const service = new SharedAggregationService();
    const response = service.aggregate(
      makeAggregationInput({ results: [makeExecutionResult({ stepResults })] }),
    );

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('DEEP_TOP_SECRET_TOKEN');
    expect(serialized).not.toContain('DEEP_TOP_SECRET_PWD');
    expect(serialized).not.toMatch(/"(token|password)":/);
  });

  it('keeps secrets out of large step metadata', () => {
    const metadata: Record<string, unknown> = {};
    for (let index = 0; index < 50; index += 1) {
      metadata[`field_${index}`] = `value_${index}`;
    }
    metadata.privateKey = 'BIG_METADATA_SECRET';

    const stepResults = Array.from({ length: 20 }, (_, index) =>
      makeStepResult({
        stepId: `step-${index + 1}`,
        order: index + 1,
        output: { ok: true },
        metadata,
      }),
    );

    const service = new SharedAggregationService();
    const response = service.aggregate(
      makeAggregationInput({ results: [makeExecutionResult({ stepResults })] }),
    );

    expect(JSON.stringify(response)).not.toContain('BIG_METADATA_SECRET');
  });

  it('does not mutate the original step outputs during sanitization', () => {
    const output = { apiKey: 'KEEP_ME', nested: { password: 'KEEP_ME_TOO' } };
    const stepResults = [makeStepResult({ stepId: 'step-1', order: 1, output })];

    const service = new SharedAggregationService();
    service.aggregate(makeAggregationInput({ results: [makeExecutionResult({ stepResults })] }));

    expect(output).toEqual({ apiKey: 'KEEP_ME', nested: { password: 'KEEP_ME_TOO' } });
  });
});
