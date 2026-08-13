import { describe, expect, it } from 'vitest';

import {
  ExecutionResultNormalizer,
  groupForStatus,
  toResultError,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/normalizers/index.js';
import { ResultNormalizationError } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/errors/index.js';
import { parseAggregationConfig } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/config/index.js';
import {
  ExecutionState,
  ExecutionEventType,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import { ResultGroup } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/types/index.js';
import { makeAggregationInput, makeExecutionResult, makeStepResult } from './fixtures.js';

const config = parseAggregationConfig({});
const normalizer = new ExecutionResultNormalizer(config);

describe('groupForStatus', () => {
  it('maps statuses to groups', () => {
    expect(groupForStatus(ExecutionStatus.Succeeded)).toBe(ResultGroup.Successful);
    expect(groupForStatus(ExecutionStatus.Failed)).toBe(ResultGroup.Failed);
    expect(groupForStatus(ExecutionStatus.TimedOut)).toBe(ResultGroup.TimedOut);
    expect(groupForStatus(ExecutionStatus.Cancelled)).toBe(ResultGroup.Cancelled);
    expect(groupForStatus(ExecutionStatus.Running)).toBe(ResultGroup.Pending);
    expect(groupForStatus(ExecutionStatus.Pending)).toBe(ResultGroup.Pending);
  });

  it('maps skipped steps to the skipped group', () => {
    expect(groupForStatus(ExecutionStatus.Cancelled, true)).toBe(ResultGroup.Skipped);
    expect(groupForStatus(ExecutionStatus.Succeeded, true)).toBe(ResultGroup.Skipped);
  });
});

describe('toResultError', () => {
  it('converts an execution error into a result error', () => {
    const step = makeStepResult({ stepId: 'step-1', agentId: 'AG-101', attemptCount: 3 });
    const error = toResultError({ code: 'E1', message: 'boom', retryable: true }, 'exec-1', step);
    expect(error.code).toBe('E1');
    expect(error.stepId).toBe('step-1');
    expect(error.agentId).toBe('AG-101');
    expect(error.executionId).toBe('exec-1');
    expect(error.attempt).toBe(3);
    expect(error.metadata).toEqual({ retryable: true });
  });
});

describe('ExecutionResultNormalizer.normalize', () => {
  it('normalizes step results without mutating the input', () => {
    const input = makeAggregationInput();
    const original = input.results[0]!;
    const results = normalizer.normalize(input);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      executionId: 'exec-1',
      stepId: 'step-1',
      agentId: 'AG-101',
      status: ExecutionStatus.Succeeded,
      group: ResultGroup.Successful,
      key: 'exec-1:step-1',
    });
    expect(original.stepResults[0]!.attemptCount).toBe(1);
  });

  it('preserves a step error', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          state: ExecutionState.Failed,
          stepResults: [
            makeStepResult({
              status: ExecutionStatus.Failed,
              error: { code: 'E1', message: 'boom', retryable: true },
            }),
          ],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    expect(results[0]!.error).toMatchObject({ code: 'E1', message: 'boom' });
  });

  it('emits a warning for skipped steps', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          state: ExecutionState.Completed,
          stepResults: [makeStepResult({ status: ExecutionStatus.Cancelled, skipped: true })],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    expect(results[0]!.group).toBe(ResultGroup.Skipped);
    expect(results[0]!.warnings.map((w) => w.code)).toContain('STEP_SKIPPED');
  });

  it('emits a retry warning for retried steps', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          stepResults: [makeStepResult({ attemptCount: 3 })],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    expect(results[0]!.warnings.map((w) => w.code)).toContain('RETRY_OCCURRED');
  });

  it('emits a fallback warning under the fallback policy', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          state: ExecutionState.Partial,
          stepResults: [
            makeStepResult({
              status: ExecutionStatus.Failed,
              error: { code: 'E', message: 'm', retryable: false },
            }),
          ],
        }),
      ],
    });
    const plan = {
      ...input.plan,
      steps: [
        {
          ...input.plan.steps[0]!,
          policy: { ...input.plan.steps[0]!.policy, failureBehavior: FailurePolicy.Fallback },
        },
      ],
    } as typeof input.plan;
    const results = normalizer.normalize({ ...input, plan });
    expect(results[0]!.warnings.map((w) => w.code)).toContain('FALLBACK_USED');
  });

  it('emits a non-critical failure warning under the continue policy', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          state: ExecutionState.Partial,
          stepResults: [
            makeStepResult({
              status: ExecutionStatus.Failed,
              error: { code: 'E', message: 'm', retryable: false },
            }),
          ],
        }),
      ],
    });
    const plan = {
      ...input.plan,
      steps: [
        {
          ...input.plan.steps[0]!,
          policy: { ...input.plan.steps[0]!.policy, failureBehavior: FailurePolicy.Continue },
        },
      ],
    } as typeof input.plan;
    const results = normalizer.normalize({ ...input, plan });
    expect(results[0]!.warnings.map((w) => w.code)).toContain('NON_CRITICAL_FAILURE');
  });

  it('emits a timeout warning for timed out steps', () => {
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          state: ExecutionState.TimedOut,
          stepResults: [makeStepResult({ status: ExecutionStatus.TimedOut })],
        }),
      ],
    });
    const results = normalizer.normalize(input);
    expect(results[0]!.warnings.map((w) => w.code)).toContain('STEP_TIMED_OUT');
  });

  it('throws when the plan contains duplicate step ids', () => {
    const input = makeAggregationInput();
    const plan = {
      ...input.plan,
      steps: [input.plan.steps[0]!, { ...input.plan.steps[0]!, stepId: 'step-1' }],
    } as typeof input.plan;
    expect(() => normalizer.normalize({ ...input, plan })).toThrow(ResultNormalizationError);
  });

  it('respects the include-warnings flag', () => {
    const silent = new ExecutionResultNormalizer(
      parseAggregationConfig({ AGGREGATION_INCLUDE_WARNINGS: 'false' }),
    );
    const input = makeAggregationInput({
      results: [
        makeExecutionResult({
          stepResults: [makeStepResult({ status: ExecutionStatus.Cancelled, skipped: true })],
        }),
      ],
    });
    const results = silent.normalize(input);
    expect(results[0]!.warnings).toHaveLength(0);
  });
});

describe('ExecutionResultNormalizer.retries', () => {
  it('returns no summaries when nothing retried', () => {
    const execution = makeExecutionResult();
    expect(normalizer.retries(execution)).toHaveLength(0);
  });

  it('reconstructs retry history from retry events', () => {
    const execution = makeExecutionResult({
      stepResults: [
        makeStepResult({ stepId: 'step-1', status: ExecutionStatus.Succeeded, attemptCount: 3 }),
      ],
      events: [
        {
          type: ExecutionEventType.StepRetrying,
          executionId: 'exec-1',
          planId: 'plan',
          stepId: 'step-1',
          attempt: 2,
          occurredAt: '2026-08-13T10:00:01.000Z',
        },
        {
          type: ExecutionEventType.StepRetrying,
          executionId: 'exec-1',
          planId: 'plan',
          stepId: 'step-1',
          attempt: 3,
          occurredAt: '2026-08-13T10:00:02.000Z',
        },
      ],
    });
    const summaries = normalizer.retries(execution);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      stepId: 'step-1',
      successfulAttempt: 3,
      failedAttempts: [1, 2],
      finalAttempt: 3,
      retryCount: 2,
    });
  });

  it('records no successful attempt for failed steps', () => {
    const execution = makeExecutionResult({
      stepResults: [
        makeStepResult({
          stepId: 'step-1',
          status: ExecutionStatus.Failed,
          attemptCount: 2,
          error: { code: 'E', message: 'm', retryable: true },
        }),
      ],
      events: [
        {
          type: ExecutionEventType.StepRetrying,
          executionId: 'exec-1',
          planId: 'plan',
          stepId: 'step-1',
          attempt: 2,
          occurredAt: '2026-08-13T10:00:01.000Z',
        },
      ],
    });
    const summaries = normalizer.retries(execution);
    expect(summaries[0]!.successfulAttempt).toBeUndefined();
    expect(summaries[0]!.failedAttempts).toEqual([1]);
  });
});
