import { describe, expect, it } from 'vitest';

import {
  AggregationStatus,
  ResultGroup,
  SharedAggregationService,
  parseAggregationConfig,
  ExecutionResultNormalizer,
  DeterministicStatusCalculator,
  AggregationStatisticsCalculator,
  StructuredResponseFormatter,
  validateAggregationInput,
  buildResponseId,
  sanitizeRecord,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import {
  DuplicateResultError,
  AggregationValidationError,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/errors/index.js';
import type { ExecutionResult } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionState } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { ExecutionPlanBuilder } from '../../../../../src/agents/ag-001-master-orchestrator/planning/builders/index.js';
import {
  makeAgentRequest,
  makeIntentResult,
  makeContextSnapshot,
  makeRouteDecision,
} from '../planning/fixtures.js';
import { UserRole } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { makeExecutionResult, makeStepResult } from './fixtures.js';

describe('aggregation public contract', () => {
  it('exposes the stable public API surface', () => {
    expect(AggregationStatus.Success).toBe('SUCCESS');
    expect(ResultGroup.Skipped).toBe('SKIPPED');
    expect(typeof parseAggregationConfig).toBe('function');
    expect(typeof validateAggregationInput).toBe('function');
    expect(typeof buildResponseId).toBe('function');
    expect(typeof sanitizeRecord).toBe('function');
    expect(new SharedAggregationService().name).toBe('shared-aggregation-service');
    expect(new ExecutionResultNormalizer(parseAggregationConfig({})).name).toBe(
      'execution-result-normalizer',
    );
    expect(new DeterministicStatusCalculator().name).toBe('deterministic-status-calculator');
    expect(new AggregationStatisticsCalculator().name).toBe('aggregation-statistics-calculator');
    expect(new StructuredResponseFormatter(parseAggregationConfig({})).version).toBe('1.0.0');
  });

  it('consumes execution results produced by the planner', () => {
    const builder = new ExecutionPlanBuilder();
    const plan = builder.build({
      requestId: 'req-1',
      traceId: 'trace-1',
      request: makeAgentRequest({ agentId: 'AG-101' }),
      intent: makeIntentResult(),
      context: makeContextSnapshot(),
      route: makeRouteDecision(),
      role: UserRole.Freelancer,
    });

    const result = makeExecutionResult({}, plan);
    const service = new SharedAggregationService();
    const response = service.aggregate({
      executionId: 'exec-1',
      plan,
      results: [result],
    });

    expect(response.planId).toBe(plan.planId);
    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.outputs).toHaveLength(1);
    expect(response.metadata.planId).toBe(plan.planId);
  });

  it('produces a structurally valid AggregatedResponse', () => {
    const service = new SharedAggregationService();
    const plan = makeAggregationInputPlan();
    const response = service.aggregate({
      executionId: 'exec-1',
      plan,
      results: [makeExecutionResult({}, plan)],
    });

    expect(response.responseId).toBeTruthy();
    expect(response.executionId).toBe('exec-1');
    expect(response.outputs).toBeDefined();
    expect(response.errors).toBeDefined();
    expect(response.warnings).toBeDefined();
    expect(response.retries).toBeDefined();
    expect(response.statistics).toBeDefined();
    expect(response.metadata).toBeDefined();
    expect(response.completedAt).toBeTruthy();
    expect(typeof response.statistics.totalSteps).toBe('number');
    expect(typeof response.statistics.totalDurationMs).toBe('number');
  });

  it('never leaks sensitive keys from metadata', () => {
    const service = new SharedAggregationService();
    const plan = makeAggregationInputPlan();
    const input = {
      executionId: 'exec-1',
      plan,
      results: [
        makeExecutionResult(
          {
            stepResults: [
              makeStepResult({
                status: ExecutionStatus.Succeeded,
                metadata: { apiKey: 'secret-value', username: 'alice', safe: true },
              }),
            ],
          },
          plan,
        ),
      ] as readonly ExecutionResult[],
    };

    const response = service.aggregate(input);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('apiKey');
  });

  it('maps execution states through the aggregation status vocabulary', () => {
    const plan = makeAggregationInputPlan();
    const states = [ExecutionState.Failed, ExecutionState.Cancelled, ExecutionState.TimedOut];
    for (const state of states) {
      const service = new SharedAggregationService();
      const input = {
        executionId: 'exec-1',
        plan,
        results: [makeExecutionResult({ state }, plan)],
      };
      const response = service.aggregate(input);
      expect(response.status).toBe(AggregationStatusValueFor(state));
    }
  });

  it('raises typed errors that the orchestrator can catch', () => {
    const service = new SharedAggregationService();
    expect(() =>
      service.aggregate({
        executionId: 'exec-1',
        plan: makeAggregationInputPlan(),
        results: [],
      }),
    ).toThrow(AggregationValidationError);

    const first = makeExecutionResult({ executionId: 'exec-1' });
    expect(() =>
      service.aggregate({
        executionId: 'exec-1',
        plan: makeAggregationInputPlan(),
        results: [first, { ...first }],
      }),
    ).toThrow(DuplicateResultError);
  });
});

function AggregationStatusValueFor(state: ExecutionState): AggregationStatus {
  switch (state) {
    case ExecutionState.Failed:
      return AggregationStatus.Failed;
    case ExecutionState.Cancelled:
      return AggregationStatus.Cancelled;
    case ExecutionState.TimedOut:
      return AggregationStatus.TimedOut;
    default:
      return AggregationStatus.Success;
  }
}

function makeAggregationInputPlan() {
  const builder = new ExecutionPlanBuilder();
  return builder.build({
    requestId: 'req-1',
    traceId: 'trace-1',
    request: makeAgentRequest({ agentId: 'AG-101' }),
    intent: makeIntentResult(),
    context: makeContextSnapshot(),
    route: makeRouteDecision(),
    role: UserRole.Freelancer,
  });
}
