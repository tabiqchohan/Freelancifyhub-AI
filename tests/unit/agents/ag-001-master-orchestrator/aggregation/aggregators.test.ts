import { describe, expect, it } from 'vitest';

import {
  SharedAggregationService,
  SingleResultAggregator,
  SequentialResultAggregator,
  ParallelResultAggregator,
  ConditionalResultAggregator,
  HybridResultAggregator,
  resolveAggregationStrategy,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/aggregators/index.js';
import { parseAggregationConfig } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/config/index.js';
import {
  AggregationValidationError,
  DuplicateResultError,
  ResultLimitError,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/errors/index.js';
import { AggregationStatus } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/types/index.js';
import {
  ExecutionState,
  ExecutionEventType,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { makeAggregationInput, makeExecutionResult, makeStepResult } from './fixtures.js';

describe('SharedAggregationService', () => {
  it('aggregates a single successful execution', () => {
    const service = new SharedAggregationService();
    const response = service.aggregate(makeAggregationInput());

    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.responseId).toBe('agg_exec-1_plan-req-ex-1');
    expect(response.outputs).toHaveLength(1);
    expect(response.outputs[0]!.stepId).toBe('step-1');
    expect(response.outputs[0]!.agentId).toBe('AG-101');
    expect(response.errors).toHaveLength(0);
    expect(response.metadata.resultCount).toBe(1);
  });

  it('is deterministic: identical input yields an identical response', () => {
    const service = new SharedAggregationService();
    const input = makeAggregationInput();
    const first = service.aggregate(input);
    const second = service.aggregate(input);

    const strip = (response: typeof first) => ({
      ...response,
      completedAt: undefined,
      metadata: { ...response.metadata, completedAt: undefined },
    });
    expect(strip(first)).toEqual(strip(second));
    expect(first.responseId).toBe(second.responseId);
  });

  it('propagates a failed execution status', () => {
    const service = new SharedAggregationService();
    const response = service.aggregate(
      makeAggregationInput({
        results: [
          makeExecutionResult({
            state: ExecutionState.Failed,
            stepResults: [
              makeStepResult({
                status: ExecutionStatus.Failed,
                error: { code: 'E1', message: 'boom', retryable: false },
              }),
            ],
          }),
        ],
      }),
    );

    expect(response.status).toBe(AggregationStatus.Failed);
    expect(response.errors).toHaveLength(1);
    expect(response.errors[0]!.code).toBe('E1');
    expect(response.outputs).toHaveLength(0);
  });

  it('marks a partial execution with failed and succeeded steps', () => {
    const service = new SharedAggregationService();
    const response = service.aggregate(
      makeAggregationInput({
        results: [
          makeExecutionResult({
            state: ExecutionState.Partial,
            stepResults: [
              makeStepResult({
                stepId: 'step-1',
                status: ExecutionStatus.Failed,
                error: { code: 'E1', message: 'boom', retryable: false },
              }),
              makeStepResult({ stepId: 'step-2', status: ExecutionStatus.Succeeded }),
            ],
          }),
        ],
      }),
    );

    expect(response.status).toBe(AggregationStatus.Partial);
    expect(response.outputs).toHaveLength(1);
  });

  it('reports cancelled executions', () => {
    const service = new SharedAggregationService();
    const response = service.aggregate(
      makeAggregationInput({
        results: [
          makeExecutionResult({
            state: ExecutionState.Cancelled,
            cancellation: {
              executionId: 'exec-1',
              reason: 'user requested',
              requestedAt: '2026-08-13T10:00:05.000Z',
            },
            stepResults: [makeStepResult({ status: ExecutionStatus.Cancelled })],
          }),
        ],
      }),
    );

    expect(response.status).toBe(AggregationStatus.Cancelled);
    expect(response.warnings.map((w) => w.code)).toContain('EXECUTION_CANCELLED');
  });

  it('throws on duplicate results under strict validation', () => {
    const service = new SharedAggregationService();
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          stepResults: [makeStepResult({ stepId: 'step-1' })],
        }),
      ],
    });
    const duplicated = makeExecutionResult({
      executionId: 'exec-1',
      stepResults: [makeStepResult({ stepId: 'step-1' })],
    });
    expect(() => service.aggregate({ ...input, results: [input.results[0]!, duplicated] })).toThrow(
      DuplicateResultError,
    );
  });

  it('discards duplicates and counts them under loose validation', () => {
    const service = new SharedAggregationService(
      parseAggregationConfig({
        AGGREGATION_STRICT_VALIDATION: 'false',
        AGGREGATION_DEDUPLICATION_ENABLED: 'true',
      }),
    );
    const result = makeExecutionResult({
      executionId: 'exec-1',
      stepResults: [makeStepResult({ stepId: 'step-1' })],
    });
    const response = service.aggregate({
      ...makeAggregationInput(),
      results: [result, { ...result }],
    });

    expect(response.outputs).toHaveLength(1);
    expect(response.statistics.duplicateCount).toBe(1);
    expect(response.warnings.map((w) => w.code)).toContain('DUPLICATE_RESULT');
  });

  it('throws when the result limit is exceeded', () => {
    const service = new SharedAggregationService(
      parseAggregationConfig({ AGGREGATION_MAX_RESULT_COUNT: '1' }),
    );
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({ executionId: 'exec-1' }),
        makeExecutionResult({ executionId: 'exec-2' }),
      ],
    });
    expect(() => service.aggregate(input)).toThrow(ResultLimitError);
  });

  it('throws for empty results under strict validation', () => {
    const service = new SharedAggregationService();
    expect(() => service.aggregate(makeAggregationInput({ results: [] }))).toThrow(
      AggregationValidationError,
    );
  });

  it('handles empty results gracefully under loose validation', () => {
    const service = new SharedAggregationService(
      parseAggregationConfig({ AGGREGATION_STRICT_VALIDATION: 'false' }),
    );
    const response = service.aggregate(makeAggregationInput({ results: [] }));
    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.outputs).toHaveLength(0);
    expect(response.statistics.totalSteps).toBe(0);
  });

  it('includes retry history', () => {
    const service = new SharedAggregationService();
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          stepResults: [
            makeStepResult({
              stepId: 'step-1',
              status: ExecutionStatus.Succeeded,
              attemptCount: 3,
            }),
          ],
          events: [
            {
              type: ExecutionEventType.StepRetrying,
              executionId: 'exec-1',
              planId: 'plan-req-ex-1',
              stepId: 'step-1',
              attempt: 2,
              occurredAt: '2026-08-13T10:00:01.000Z',
            },
            {
              type: ExecutionEventType.StepRetrying,
              executionId: 'exec-1',
              planId: 'plan-req-ex-1',
              stepId: 'step-1',
              attempt: 3,
              occurredAt: '2026-08-13T10:00:02.000Z',
            },
          ],
        }),
      ],
    });
    const response = service.aggregate(input);
    expect(response.retries).toHaveLength(1);
    expect(response.retries[0]).toMatchObject({
      stepId: 'step-1',
      retryCount: 2,
      failedAttempts: [1, 2],
    });
  });

  it('emits a dependency-failed warning when a prerequisite failed', () => {
    const service = new SharedAggregationService();
    const plan = makeAggregationInput().plan;
    const input = makeAggregationInput({
      plan: {
        ...plan,
        dependencies: [{ stepId: 'step-2', dependsOn: 'step-1', required: true }],
      } as typeof plan,
      results: [
        makeExecutionResult({
          state: ExecutionState.Failed,
          stepResults: [
            makeStepResult({
              stepId: 'step-1',
              status: ExecutionStatus.Failed,
              error: { code: 'E1', message: 'boom', retryable: false },
            }),
            makeStepResult({ stepId: 'step-2', status: ExecutionStatus.Failed }),
          ],
        }),
      ],
    });
    const response = service.aggregate(input);
    expect(response.warnings.map((w) => w.code)).toContain('DEPENDENCY_FAILED');
  });

  it('aggregates multiple executions and preserves origin', () => {
    const service = new SharedAggregationService();
    const input = makeAggregationInput({
      executionId: 'agg-1',
      results: [
        makeExecutionResult({
          executionId: 'exec-1',
          stepResults: [makeStepResult({ stepId: 'step-1', agentId: 'AG-101' })],
        }),
        makeExecutionResult({
          executionId: 'exec-2',
          stepResults: [makeStepResult({ stepId: 'step-2', agentId: 'AG-102' })],
        }),
      ],
    });
    const response = service.aggregate(input);
    expect(response.outputs).toHaveLength(2);
    expect(response.outputs[0]!.executionId).toBe('exec-1');
    expect(response.outputs[1]!.executionId).toBe('exec-2');
    expect(response.statistics.agentCount).toBe(2);
  });
});

describe('aggregation strategies', () => {
  it('resolves a strategy for every execution mode', () => {
    expect(resolveAggregationStrategy(ExecutionMode.Single)).toBeInstanceOf(SingleResultAggregator);
    expect(resolveAggregationStrategy(ExecutionMode.Sequential)).toBeInstanceOf(
      SequentialResultAggregator,
    );
    expect(resolveAggregationStrategy(ExecutionMode.Parallel)).toBeInstanceOf(
      ParallelResultAggregator,
    );
    expect(resolveAggregationStrategy(ExecutionMode.Conditional)).toBeInstanceOf(
      ConditionalResultAggregator,
    );
    expect(resolveAggregationStrategy(ExecutionMode.Hybrid)).toBeInstanceOf(HybridResultAggregator);
  });

  it('exposes names and modes', () => {
    expect(new SingleResultAggregator().name).toBe('single-result-aggregator');
    expect(new SingleResultAggregator().mode).toBe(ExecutionMode.Single);
    expect(new SequentialResultAggregator().mode).toBe(ExecutionMode.Sequential);
    expect(new ParallelResultAggregator().mode).toBe(ExecutionMode.Parallel);
    expect(new ConditionalResultAggregator().mode).toBe(ExecutionMode.Conditional);
    expect(new HybridResultAggregator().mode).toBe(ExecutionMode.Hybrid);
  });

  it('aggregates through a strategy using the shared pipeline', () => {
    const strategy = new SingleResultAggregator();
    const response = strategy.aggregate(makeAggregationInput());
    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.outputs).toHaveLength(1);
  });

  it('accepts a shared service instance', () => {
    const service = new SharedAggregationService();
    const strategy = new SingleResultAggregator(service);
    expect(strategy.aggregate(makeAggregationInput()).responseId).toBe('agg_exec-1_plan-req-ex-1');
  });
});
