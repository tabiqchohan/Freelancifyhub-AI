import { describe, expect, it, beforeEach } from 'vitest';

import type { RequestContext } from '../../../../src/agents/ag-001-master-orchestrator/interfaces/index.js';
import {
  createRequestId,
  createTraceId,
  nowIso,
} from '../../../../src/agents/ag-001-master-orchestrator/utils/ids.js';
import {
  validateAgentRequest,
  validateAgentResponse,
} from '../../../../src/agents/ag-001-master-orchestrator/validators/agent.validator.js';
import { ExecutionStatus } from '../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { ValidationError } from '../../../../src/agents/ag-001-master-orchestrator/errors/index.js';

function requestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    traceId: createTraceId(),
    requestId: createRequestId(),
    receivedAt: nowIso(),
    ...overrides,
  };
}

describe('agent validators', () => {
  let context: RequestContext;

  beforeEach(() => {
    context = requestContext();
  });

  it('accepts a well-formed AgentRequest', () => {
    const request = validateAgentRequest({
      agentId: 'AG-001',
      type: 'test.type',
      payload: { marker: true },
      context,
    });

    expect(request.agentId).toBe('AG-001');
    expect(request.type).toBe('test.type');
  });

  it('rejects a request without an agent id', () => {
    expect(() =>
      validateAgentRequest({
        agentId: '',
        type: 'test.type',
        context,
      }),
    ).toThrowError(ValidationError);
  });

  it('accepts a request carrying a minimal context shape', () => {
    expect(() =>
      validateAgentRequest({
        agentId: 'AG-001',
        type: 'test.type',
        context: { requestId: 'req', receivedAt: nowIso(), traceId: 'trace' },
      }),
    ).not.toThrow();
  });

  it('accepts a well-formed AgentResponse', () => {
    const response = validateAgentResponse({
      agentId: 'AG-001',
      requestId: context.requestId,
      status: ExecutionStatus.Succeeded,
      payload: { ok: true },
      metadata: {
        agentId: 'AG-001',
        requestId: context.requestId,
        traceId: context.traceId,
        startedAt: nowIso(),
        completedAt: nowIso(),
        durationMs: 5,
        attempts: 1,
        status: ExecutionStatus.Succeeded,
      },
    });

    expect(response.status).toBe(ExecutionStatus.Succeeded);
  });

  it('rejects an invalid status enum value in a response', () => {
    expect(() =>
      validateAgentResponse({
        agentId: 'AG-001',
        requestId: context.requestId,
        status: 'unknown',
        metadata: {
          agentId: 'AG-001',
          requestId: context.requestId,
          traceId: context.traceId,
          startedAt: nowIso(),
          durationMs: 0,
          attempts: 1,
          status: 'unknown',
        },
      }),
    ).toThrowError(ValidationError);
  });

  it('clears undefined optional fields', () => {
    const response = validateAgentResponse({
      agentId: 'AG-001',
      requestId: context.requestId,
      status: ExecutionStatus.Failed,
      metadata: {
        agentId: 'AG-001',
        requestId: context.requestId,
        traceId: context.traceId,
        startedAt: nowIso(),
        durationMs: 1,
        attempts: 2,
        status: ExecutionStatus.Failed,
      },
      error: { code: 'X', message: 'boom' },
    });

    expect(response.error).toBeDefined();
    expect(response.payload).toBeUndefined();
  });
});
