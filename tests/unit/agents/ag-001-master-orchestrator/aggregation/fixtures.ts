import type { ExecutionPlan } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import type {
  ExecutionResult,
  ExecutionStepResult,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import {
  ExecutionState,
  ExecutionEventType,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import type { AggregationInput } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/types/index.js';
import { buildPlanForMode, buildSinglePlan } from '../execution/fixtures.js';

const NOW = '2026-08-13T10:00:00.000Z';

export function makeStepResult(overrides: Partial<ExecutionStepResult> = {}): ExecutionStepResult {
  return {
    stepId: 'step-1',
    agentId: 'AG-101',
    order: 1,
    status: ExecutionStatus.Succeeded,
    attemptCount: 1,
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 10,
    output: { result: 'ok' },
    ...overrides,
  };
}

export function makeExecutionResult(
  overrides: Partial<ExecutionResult> = {},
  plan: ExecutionPlan = buildSinglePlan(),
): ExecutionResult {
  const executionId = overrides.executionId ?? 'exec-1';
  const stepResults = overrides.stepResults ?? [makeStepResult()];

  return {
    executionId,
    planId: plan.planId,
    requestId: plan.requestId,
    traceId: plan.traceId,
    state: ExecutionState.Completed,
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 10,
    stepResults,
    events: [
      {
        type: ExecutionEventType.ExecutionStarted,
        executionId,
        planId: plan.planId,
        occurredAt: NOW,
      },
      {
        type: ExecutionEventType.ExecutionCompleted,
        executionId,
        planId: plan.planId,
        occurredAt: NOW,
      },
    ],
    metrics: {
      executionId,
      planId: plan.planId,
      startTime: NOW,
      endTime: NOW,
      durationMs: 10,
      totalSteps: stepResults.length,
      completedSteps: stepResults.length,
      failedSteps: 0,
      cancelledSteps: 0,
      timedOutSteps: 0,
      retryCount: 0,
      parallelBranches: 1,
      finalStatus: ExecutionState.Completed,
    },
    ...overrides,
  };
}

export function makeAggregationInput(
  overrides: Partial<AggregationInput> = {},
  plan: ExecutionPlan = buildSinglePlan(),
): AggregationInput {
  return {
    executionId: 'exec-1',
    plan,
    results: [makeExecutionResult({}, plan)],
    ...overrides,
  };
}

export function makeMultiStepPlan(): ExecutionPlan {
  return buildPlanForMode(ExecutionMode.Sequential);
}
