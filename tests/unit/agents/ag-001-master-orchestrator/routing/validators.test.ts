import { describe, expect, it } from 'vitest';

import {
  validateRouteRequest,
  validateConstraints,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/validators/index.js';
import { RoutingValidationError } from '../../../../../src/agents/ag-001-master-orchestrator/routing/errors/index.js';
import { UserRole } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import {
  makeIntentDefinition,
  makeIntentResult,
  makeAgentRequest,
  makeContextSnapshot,
} from './fixtures.js';

function validRequest() {
  return {
    requestId: 'req-1',
    traceId: 'trace-1',
    request: makeAgentRequest(),
    intent: makeIntentResult(),
    context: makeContextSnapshot(),
    role: UserRole.Freelancer,
  };
}

describe('validateRouteRequest', () => {
  it('accepts a valid routing request', () => {
    expect(() => validateRouteRequest(validRequest())).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => validateRouteRequest(null)).toThrow(RoutingValidationError);
    expect(() => validateRouteRequest(undefined)).toThrow(RoutingValidationError);
  });

  it('rejects a missing agent request', () => {
    expect(() => validateRouteRequest({ ...validRequest(), request: undefined })).toThrow(
      RoutingValidationError,
    );
  });

  it('rejects a request with a blank agentId', () => {
    expect(() =>
      validateRouteRequest({
        ...validRequest(),
        request: makeAgentRequest({ agentId: '   ' }),
      }),
    ).toThrow(RoutingValidationError);
  });

  it('rejects a missing intent result', () => {
    expect(() => validateRouteRequest({ ...validRequest(), intent: undefined })).toThrow(
      RoutingValidationError,
    );
  });

  it('rejects an invalid intent id', () => {
    const invalid = makeIntentResult(makeIntentDefinition({ id: 'not.real' as never }));

    expect(() => validateRouteRequest({ ...validRequest(), intent: invalid })).toThrow(
      RoutingValidationError,
    );
  });

  it('rejects a missing context snapshot', () => {
    expect(() => validateRouteRequest({ ...validRequest(), context: undefined })).toThrow(
      RoutingValidationError,
    );
  });

  it('rejects an invalid role', () => {
    expect(() => validateRouteRequest({ ...validRequest(), role: 'Nope' as UserRole })).toThrow(
      RoutingValidationError,
    );
  });

  it('accepts undefined constraints', () => {
    expect(() => validateRouteRequest({ ...validRequest(), constraints: undefined })).not.toThrow();
  });
});

describe('validateConstraints', () => {
  it('accepts valid constraints', () => {
    expect(() =>
      validateConstraints({
        allowedRoles: [UserRole.Freelancer],
        excludedAgents: ['AG-101'],
        maxCandidates: 3,
        minConfidence: 0.5,
      }),
    ).not.toThrow();
  });

  it('rejects an invalid role', () => {
    expect(() => validateConstraints({ allowedRoles: ['Nope' as UserRole] })).toThrow(
      RoutingValidationError,
    );
  });

  it('rejects duplicate excluded agents', () => {
    expect(() => validateConstraints({ excludedAgents: ['AG-101', 'AG-101'] })).toThrow(
      RoutingValidationError,
    );
  });

  it('rejects a non-positive maxCandidates', () => {
    expect(() => validateConstraints({ maxCandidates: 0 })).toThrow(RoutingValidationError);
    expect(() => validateConstraints({ maxCandidates: 2.5 })).toThrow(RoutingValidationError);
  });

  it('rejects an out-of-range minConfidence', () => {
    expect(() => validateConstraints({ minConfidence: 1.5 })).toThrow(RoutingValidationError);
    expect(() => validateConstraints({ minConfidence: -0.1 })).toThrow(RoutingValidationError);
  });

  it('rejects an out-of-range maxRoutingCost', () => {
    expect(() => validateConstraints({ maxRoutingCost: 2 })).toThrow(RoutingValidationError);
  });
});
