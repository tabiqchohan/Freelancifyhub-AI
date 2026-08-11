import { describe, expect, it } from 'vitest';

import {
  validatePlanningRequest,
  validateRouteDecision,
  validateConstraints,
} from '../../../../../src/agents/ag-001-master-orchestrator/planning/validators/index.js';
import { ExecutionPlanValidationError } from '../../../../../src/agents/ag-001-master-orchestrator/planning/errors/index.js';
import { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { UserRole } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import {
  makeAgentRequest,
  makeIntentResult,
  makeContextSnapshot,
  makeRouteDecision,
} from './fixtures.js';

function validRequest() {
  return {
    requestId: 'req-1',
    traceId: 'trace-1',
    request: makeAgentRequest(),
    intent: makeIntentResult(),
    context: makeContextSnapshot(),
    route: makeRouteDecision(),
    role: UserRole.Freelancer,
  };
}

describe('validatePlanningRequest', () => {
  it('accepts a valid planning request', () => {
    expect(() => validatePlanningRequest(validRequest())).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => validatePlanningRequest(null)).toThrow(ExecutionPlanValidationError);
    expect(() => validatePlanningRequest(undefined)).toThrow(ExecutionPlanValidationError);
  });

  it('rejects a missing agent request', () => {
    expect(() => validatePlanningRequest({ ...validRequest(), request: undefined })).toThrow(
      ExecutionPlanValidationError,
    );
  });

  it('rejects a missing intent', () => {
    expect(() => validatePlanningRequest({ ...validRequest(), intent: undefined })).toThrow(
      ExecutionPlanValidationError,
    );
  });

  it('rejects a missing context snapshot', () => {
    expect(() => validatePlanningRequest({ ...validRequest(), context: undefined })).toThrow(
      ExecutionPlanValidationError,
    );
  });

  it('rejects a missing route decision', () => {
    expect(() => validatePlanningRequest({ ...validRequest(), route: undefined })).toThrow(
      ExecutionPlanValidationError,
    );
  });

  it('rejects an invalid role', () => {
    expect(() => validatePlanningRequest({ ...validRequest(), role: 'Nope' as UserRole })).toThrow(
      ExecutionPlanValidationError,
    );
  });
});

describe('validateRouteDecision', () => {
  it('accepts a valid route decision', () => {
    expect(() => validateRouteDecision(makeRouteDecision())).not.toThrow();
  });

  it('rejects an invalid execution mode', () => {
    expect(() =>
      validateRouteDecision(makeRouteDecision({ executionMode: 'bogus' as ExecutionMode })),
    ).toThrow(ExecutionPlanValidationError);
  });

  it('rejects a non-single route without candidates', () => {
    expect(() =>
      validateRouteDecision(
        makeRouteDecision({ executionMode: ExecutionMode.Parallel, candidates: [] }),
      ),
    ).toThrow(ExecutionPlanValidationError);
  });

  it('accepts a single route without candidates', () => {
    expect(() =>
      validateRouteDecision(
        makeRouteDecision({ executionMode: ExecutionMode.Single, candidates: [] }),
      ),
    ).not.toThrow();
  });
});

describe('validateConstraints', () => {
  it('accepts valid constraints', () => {
    expect(() =>
      validateConstraints({ maxSteps: 5, maxDepth: 3, maxParallelBranches: 2 }),
    ).not.toThrow();
  });

  it('accepts undefined constraints', () => {
    expect(() => validateConstraints(undefined)).not.toThrow();
  });

  it('rejects a non-positive maxSteps', () => {
    expect(() => validateConstraints({ maxSteps: 0 })).toThrow(ExecutionPlanValidationError);
  });

  it('rejects a fractional maxDepth', () => {
    expect(() => validateConstraints({ maxDepth: 2.5 })).toThrow(ExecutionPlanValidationError);
  });
});
