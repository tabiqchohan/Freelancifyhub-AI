import { describe, expect, it } from 'vitest';

import {
  buildDependencyGraph,
  validateDependency,
  validateStepIds,
  estimateExecutionStages,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/dependencies/index.js';
import {
  ExecutionCycleError,
  ExecutionDependencyError,
  ExecutionPlanValidationError,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/errors/index.js';
import { ExecutionStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import {
  FailurePolicy,
  type ExecutionStep,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';

function makeStep(stepIdValue: string): ExecutionStep {
  return {
    stepId: stepIdValue,
    agentId: 'AG-101',
    order: 0,
    capabilities: [],
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
  };
}

describe('validateStepIds', () => {
  it('accepts unique non-empty step ids', () => {
    expect(() => validateStepIds([makeStep('step-1'), makeStep('step-2')])).not.toThrow();
  });

  it('rejects duplicate step ids', () => {
    expect(() => validateStepIds([makeStep('step-1'), makeStep('step-1')])).toThrow(
      ExecutionPlanValidationError,
    );
  });

  it('rejects empty step ids', () => {
    expect(() => validateStepIds([makeStep('')])).toThrow(ExecutionPlanValidationError);
  });
});

describe('validateDependency', () => {
  const ids = new Set(['step-1', 'step-2', 'step-3']);

  it('accepts a valid dependency', () => {
    expect(() =>
      validateDependency({ stepId: 'step-2', dependsOn: 'step-1', required: true }, ids),
    ).not.toThrow();
  });

  it('rejects an empty dependency id', () => {
    expect(() =>
      validateDependency({ stepId: '', dependsOn: 'step-1', required: true }, ids),
    ).toThrow(ExecutionDependencyError);
  });

  it('rejects a self dependency', () => {
    expect(() =>
      validateDependency({ stepId: 'step-1', dependsOn: 'step-1', required: true }, ids),
    ).toThrow(ExecutionDependencyError);
  });

  it('rejects a dependency on an unknown step', () => {
    expect(() =>
      validateDependency({ stepId: 'step-2', dependsOn: 'missing', required: true }, ids),
    ).toThrow(ExecutionDependencyError);
  });

  it('rejects a dependency from an unknown step', () => {
    expect(() =>
      validateDependency({ stepId: 'missing', dependsOn: 'step-1', required: true }, ids),
    ).toThrow(ExecutionDependencyError);
  });
});

describe('buildDependencyGraph', () => {
  it('detects a circular dependency', () => {
    const steps = [makeStep('step-1'), makeStep('step-2')];
    const dependencies = [
      { stepId: 'step-2', dependsOn: 'step-1', required: true },
      { stepId: 'step-1', dependsOn: 'step-2', required: true },
    ];

    expect(() => buildDependencyGraph(steps, dependencies)).toThrow(ExecutionCycleError);
  });

  it('builds a valid acyclic graph', () => {
    const steps = [makeStep('step-1'), makeStep('step-2'), makeStep('step-3')];
    const dependencies = [
      { stepId: 'step-2', dependsOn: 'step-1', required: true },
      { stepId: 'step-3', dependsOn: 'step-2', required: true },
    ];

    const graph = buildDependencyGraph(steps, dependencies);

    expect(graph.roots).toEqual(['step-1']);
    expect(graph.order).toEqual(['step-1', 'step-2', 'step-3']);
    expect(graph.maximumDepth).toBe(2);
    expect(estimateExecutionStages(graph.order, graph.edges)).toBe(3);
  });

  it('supports parallel roots', () => {
    const steps = [makeStep('step-1'), makeStep('step-2')];
    const graph = buildDependencyGraph(steps, []);

    expect(graph.roots).toEqual(['step-1', 'step-2']);
    expect(graph.maximumDepth).toBe(0);
  });
});
