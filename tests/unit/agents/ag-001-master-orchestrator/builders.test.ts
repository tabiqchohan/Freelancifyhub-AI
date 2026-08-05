import { describe, expect, it } from 'vitest';

import { RequestContextBuilder } from '../../../../src/agents/ag-001-master-orchestrator/builders/request-context.builder.js';
import { ExecutionContextBuilder } from '../../../../src/agents/ag-001-master-orchestrator/builders/execution-context.builder.js';
import { ResponseBuilder } from '../../../../src/agents/ag-001-master-orchestrator/builders/response.builder.js';
import { ExecutionStatus } from '../../../../src/agents/ag-001-master-orchestrator/types/index.js';

describe('RequestContextBuilder', () => {
  it('builds a context with generated ids and timestamp', () => {
    const context = new RequestContextBuilder().build();

    expect(context.traceId).toMatch(/^trace_/);
    expect(context.requestId).toMatch(/^req_/);
    expect(Number.isNaN(Date.parse(context.receivedAt))).toBe(false);
  });

  it('respects explicit overrides', () => {
    const context = new RequestContextBuilder()
      .withTraceId('trace-xyz')
      .withRequestId('req-abc')
      .withOrigin('gateway')
      .build();

    expect(context.traceId).toBe('trace-xyz');
    expect(context.requestId).toBe('req-abc');
    expect(context.origin).toBe('gateway');
  });

  it('rejects an invalid build (empty trace id)', () => {
    expect(() => new RequestContextBuilder().withTraceId('').build()).toThrow();
  });
});

describe('ExecutionContextBuilder', () => {
  it('copies correlation ids from the request context', () => {
    const request = new RequestContextBuilder().withTraceId('trace-1').build();

    const execution = new ExecutionContextBuilder()
      .withAgentId('AG-001')
      .forRequest(request)
      .build();

    expect(execution.agentId).toBe('AG-001');
    expect(execution.traceId).toBe('trace-1');
    expect(execution.requestId).toBe(request.requestId);
    expect(typeof execution.startedAt).toBe('string');
  });

  it('carries the injected state shape', () => {
    const request = new RequestContextBuilder().build();
    const execution = new ExecutionContextBuilder<{ stage: string }>()
      .withAgentId('AG-001')
      .forRequest(request)
      .withState({ stage: 'input' })
      .build();

    expect(execution.state.stage).toBe('input');
  });
});

describe('ResponseBuilder', () => {
  it('builds a successful response with metadata', () => {
    const response = new ResponseBuilder()
      .withAgentId('AG-001')
      .withRequestId('req-1')
      .withTraceId('trace-1')
      .success({ done: true });

    expect(response.status).toBe(ExecutionStatus.Succeeded);
    expect(response.payload).toEqual({ done: true });
    expect(response.metadata.agentId).toBe('AG-001');
    expect(response.metadata.requestId).toBe('req-1');
    expect(response.metadata.traceId).toBe('trace-1');
    expect(response.metadata.attempts).toBe(1);
    expect(response.error).toBeUndefined();
  });

  it('builds a failed response with the error contract', () => {
    const response = new ResponseBuilder()
      .withAgentId('AG-001')
      .withRequestId('req-1')
      .withTraceId('trace-1')
      .withAttempts(2)
      .failure({ code: 'E1', message: 'nope', retryable: true });

    expect(response.status).toBe(ExecutionStatus.Failed);
    expect(response.error).toEqual({ code: 'E1', message: 'nope', retryable: true });
    expect(response.metadata.attempts).toBe(2);
    expect(response.payload).toBeUndefined();
  });

  it('computes a non-negative duration from the start time', () => {
    const startedAt = new Date(Date.now() - 2000).toISOString();
    const response = new ResponseBuilder()
      .withAgentId('AG-001')
      .withRequestId('req-1')
      .withTraceId('trace-1')
      .withStartedAt(startedAt)
      .success({ done: true });

    expect(response.metadata.durationMs).toBeGreaterThanOrEqual(0);
  });
});
