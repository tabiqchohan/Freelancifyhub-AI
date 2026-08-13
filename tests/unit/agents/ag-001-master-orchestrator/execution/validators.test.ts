import { describe, expect, it } from 'vitest';

import {
  validateExecutionRequest,
  validateExecutionPlan,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/validators/index.js';
import { ExecutionValidationError } from '../../../../../src/agents/ag-001-master-orchestrator/execution/errors/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { buildSinglePlan, buildPlanForMode } from './fixtures.js';

describe('validateExecutionRequest', () => {
  it('accepts a well-formed request', () => {
    expect(() =>
      validateExecutionRequest({
        executionId: 'exec-1',
        plan: buildSinglePlan(),
      }),
    ).not.toThrow();
  });

  it('rejects a non-object request', () => {
    expect(() => validateExecutionRequest('nope' as never)).toThrow(ExecutionValidationError);
  });

  it('rejects a missing execution id', () => {
    expect(() => validateExecutionRequest({ plan: buildSinglePlan() } as never)).toThrow(
      ExecutionValidationError,
    );
  });

  it('rejects a missing plan', () => {
    expect(() => validateExecutionRequest({ executionId: 'exec-1' })).toThrow(
      ExecutionValidationError,
    );
  });
});

describe('validateExecutionPlan', () => {
  it('accepts a valid plan', () => {
    expect(() => validateExecutionPlan(buildSinglePlan())).not.toThrow();
  });

  it('rejects an invalid execution mode', () => {
    const plan = buildSinglePlan();
    expect(() => validateExecutionPlan({ ...plan, mode: 'teleport' as ExecutionMode })).toThrow(
      ExecutionValidationError,
    );
  });

  it('rejects a plan without steps', () => {
    const plan = buildPlanForMode(ExecutionMode.Sequential);
    expect(() => validateExecutionPlan({ ...plan, steps: [] })).toThrow(ExecutionValidationError);
  });
});
