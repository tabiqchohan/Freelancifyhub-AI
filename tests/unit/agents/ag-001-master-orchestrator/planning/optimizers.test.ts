import { describe, expect, it } from 'vitest';

import {
  SafePlanOptimizer,
  safePlanOptimizer,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/optimizers/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import type {
  ExecutionStep,
  ExecutionDependency,
  ExecutionCondition,
  ExecutionBranch,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import {
  ConditionOperator,
  FailurePolicy,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';

function makeStep(stepIdValue: string, overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    stepId: stepIdValue,
    agentId: 'AG-101',
    order: 0,
    capabilities: ['project.create'],
    dependencies: [],
    input: [],
    output: [],
    policy: {
      timeoutMs: 10000,
      retry: { maxRetries: 2, retryable: true },
      failureBehavior: FailurePolicy.FailFast,
      continueOnFailure: false,
      stopOnFailure: true,
      fallbackAllowed: true,
      maxSteps: 10,
      maxTotalExecutionTimeMs: 100000,
    },
    status: ExecutionStatus.Pending,
    timeoutMs: 10000,
    retry: { maxRetries: 2, retryable: true },
    ...overrides,
  };
}

describe('SafePlanOptimizer', () => {
  it('exposes a shared singleton', () => {
    expect(safePlanOptimizer).toBeInstanceOf(SafePlanOptimizer);
  });

  it('removes exact duplicate steps', () => {
    const optimizer = new SafePlanOptimizer();
    const result = optimizer.optimize({
      steps: [makeStep('step-1'), makeStep('step-2')],
      dependencies: [],
      conditions: [],
      branches: [],
    });

    expect(result.steps).toHaveLength(1);
    expect(result.optimizations.some((warning) => warning.code === 'DUPLICATE_STEP_REMOVED')).toBe(
      true,
    );
  });

  it('keeps distinct steps intact', () => {
    const optimizer = new SafePlanOptimizer();
    const result = optimizer.optimize({
      steps: [makeStep('step-1', { agentId: 'AG-101' }), makeStep('step-2', { agentId: 'AG-102' })],
      dependencies: [],
      conditions: [],
      branches: [],
    });

    expect(result.steps).toHaveLength(2);
    expect(result.optimizations).toHaveLength(0);
  });

  it('removes unreachable steps', () => {
    const optimizer = new SafePlanOptimizer();
    const result = optimizer.optimize({
      steps: [makeStep('step-1'), makeStep('step-2', { agentId: 'AG-102' })],
      dependencies: [{ stepId: 'step-2', dependsOn: 'step-missing', required: true }],
      conditions: [],
      branches: [],
    });

    expect(result.steps.some((step) => step.stepId === 'step-2')).toBe(false);
    expect(result.steps.some((step) => step.stepId === 'step-1')).toBe(true);
    expect(
      result.optimizations.some((warning) => warning.code === 'UNREACHABLE_STEP_REMOVED'),
    ).toBe(true);
  });

  it('removes dangling dependencies', () => {
    const optimizer = new SafePlanOptimizer();
    const dependency: ExecutionDependency = {
      stepId: 'step-2',
      dependsOn: 'missing',
      required: true,
    };
    const result = optimizer.optimize({
      steps: [makeStep('step-1')],
      dependencies: [dependency],
      conditions: [],
      branches: [],
    });

    expect(result.dependencies).toHaveLength(0);
    expect(
      result.optimizations.some((warning) => warning.code === 'DANGLING_DEPENDENCY_REMOVED'),
    ).toBe(true);
  });

  it('merges identical conditions', () => {
    const optimizer = new SafePlanOptimizer();
    const condition: ExecutionCondition = {
      id: 'cond-1',
      operator: ConditionOperator.GreaterThan,
      field: 'route.confidence',
      value: 0.8,
    };
    const result = optimizer.optimize({
      steps: [makeStep('step-1')],
      dependencies: [],
      conditions: [condition, { ...condition }],
      branches: [],
    });

    expect(result.conditions).toHaveLength(1);
    expect(result.optimizations.some((warning) => warning.code === 'CONDITION_MERGED')).toBe(true);
  });

  it('removes empty branches', () => {
    const optimizer = new SafePlanOptimizer();
    const condition: ExecutionCondition = {
      id: 'cond-1',
      operator: ConditionOperator.Exists,
      field: 'route.confidence',
    };
    const branch: ExecutionBranch = {
      branchId: 'branch-1',
      condition,
      stepIds: ['step-2'],
      order: 0,
    };
    const result = optimizer.optimize({
      steps: [makeStep('step-1')],
      dependencies: [],
      conditions: [condition],
      branches: [branch],
    });

    expect(result.branches).toHaveLength(0);
    expect(result.optimizations.some((warning) => warning.code === 'EMPTY_BRANCH_REMOVED')).toBe(
      true,
    );
  });
});
