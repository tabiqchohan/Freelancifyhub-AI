import { describe, expect, it } from 'vitest';

import {
  StructuredResponseFormatter,
  buildResponseId,
  deduplicateWarnings,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/formatters/index.js';
import { ExecutionResultNormalizer } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/normalizers/index.js';
import { DeterministicStatusCalculator } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/status/index.js';
import { AggregationStatisticsCalculator } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/statistics/index.js';
import { parseAggregationConfig } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/config/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { makeAggregationInput, makeExecutionResult, makeStepResult } from './fixtures.js';

const config = parseAggregationConfig({});
const normalizer = new ExecutionResultNormalizer(config);
const status = new DeterministicStatusCalculator();
const statistics = new AggregationStatisticsCalculator();

function format(input = makeAggregationInput()) {
  const results = normalizer.normalize(input);
  const finalStatus = status.calculate(results, input);
  const stats = statistics.calculate(input, results);
  const retries = input.results.flatMap((execution) => normalizer.retries(execution));
  return new StructuredResponseFormatter(config).format(
    input,
    results,
    finalStatus,
    stats,
    retries,
  );
}

describe('buildResponseId', () => {
  it('builds a deterministic response id', () => {
    expect(buildResponseId('exec-1', 'plan-1')).toBe('agg_exec-1_plan-1');
    expect(buildResponseId('exec-1', 'plan-1')).toBe(buildResponseId('exec-1', 'plan-1'));
  });
});

describe('deduplicateWarnings', () => {
  it('removes exact duplicates while preserving order', () => {
    const warnings = [
      { code: 'A', message: 'same' },
      { code: 'A', message: 'same' },
      { code: 'B', message: 'other' },
    ];
    expect(deduplicateWarnings(warnings).map((w) => w.code)).toEqual(['A', 'B']);
  });
});

describe('StructuredResponseFormatter', () => {
  it('reports its version', () => {
    expect(new StructuredResponseFormatter(config).version).toBe('1.0.0');
  });

  it('builds outputs only from successful non-skipped results', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          state: ExecutionState.Partial,
          stepResults: [
            makeStepResult({ stepId: 'step-1', status: ExecutionStatus.Succeeded }),
            makeStepResult({
              stepId: 'step-2',
              status: ExecutionStatus.Failed,
              error: { code: 'E', message: 'boom', retryable: false },
            }),
            makeStepResult({ stepId: 'step-3', status: ExecutionStatus.Cancelled, skipped: true }),
          ],
        }),
      ],
    });
    const response = format(input);
    expect(response.outputs.map((o) => o.stepId)).toEqual(['step-1']);
    expect(response.errors.map((e) => e.stepId)).toEqual(['step-2']);
  });

  it('sorts errors by step id', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          state: ExecutionState.Failed,
          stepResults: [
            makeStepResult({
              stepId: 'step-b',
              status: ExecutionStatus.Failed,
              error: { code: 'EB', message: 'b', retryable: false },
            }),
            makeStepResult({
              stepId: 'step-a',
              status: ExecutionStatus.Failed,
              error: { code: 'EA', message: 'a', retryable: false },
            }),
          ],
        }),
      ],
    });
    const response = format(input);
    expect(response.errors.map((e) => e.stepId)).toEqual(['step-a', 'step-b']);
  });

  it('builds metadata with safe aggregates', () => {
    const response = format();
    expect(response.metadata).toMatchObject({
      responseId: 'agg_exec-1_plan-req-ex-1',
      executionId: 'exec-1',
      planId: 'plan-req-ex-1',
      agentIds: ['AG-101'],
      stepIds: ['step-1'],
      resultCount: 1,
    });
  });

  it('includes execution-level warnings', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          state: ExecutionState.Partial,
          stepResults: [makeStepResult({ status: ExecutionStatus.Succeeded })],
        }),
      ],
    });
    const response = format(input);
    expect(response.warnings.map((w) => w.code)).toContain('PARTIAL_EXECUTION');
  });

  it('truncates oversized metadata and emits a warning', () => {
    const tiny = parseAggregationConfig({ AGGREGATION_MAX_METADATA_SIZE: '100' });
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          stepResults: [
            makeStepResult({ stepId: 'step-1', agentId: 'AG-101' }),
            makeStepResult({ stepId: 'step-2', agentId: 'AG-102' }),
            makeStepResult({ stepId: 'step-3', agentId: 'AG-103' }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    const finalStatus = status.calculate(results, input);
    const stats = statistics.calculate(input, results);
    const response = new StructuredResponseFormatter(tiny).format(
      input,
      results,
      finalStatus,
      stats,
      [],
    );

    expect(response.metadata.stepIds).toEqual([]);
    expect(response.warnings.map((w) => w.code)).toContain('TRUNCATED_METADATA');
  });

  it('omits errors and warnings when disabled by config', () => {
    const quiet = parseAggregationConfig({
      AGGREGATION_INCLUDE_ERRORS: 'false',
      AGGREGATION_INCLUDE_WARNINGS: 'false',
    });
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          state: ExecutionState.Failed,
          stepResults: [
            makeStepResult({
              status: ExecutionStatus.Failed,
              error: { code: 'E', message: 'm', retryable: false },
            }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    const finalStatus = status.calculate(results, input);
    const stats = statistics.calculate(input, results);
    const response = new StructuredResponseFormatter(quiet).format(
      input,
      results,
      finalStatus,
      stats,
      [],
    );

    expect(response.errors).toHaveLength(0);
    expect(response.warnings).toHaveLength(0);
  });
});
