import { describe, expect, it } from 'vitest';

import {
  MemoryAwareContextInputBuilder,
  derivation,
} from '../../../src/app/memory-context-builder.js';
import { RequestActorRegistry } from '../../../src/app/request-actors.js';
import { MemoryActorGroup } from '../../../src/agents/ag-002-memory-manager/index.js';
import { FailurePolicy } from '../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import type { AgentExecutionRequest } from '../../../src/agents/ag-001-master-orchestrator/execution/index.js';

function request(executionId: string, inputs: Record<string, unknown> = {}): AgentExecutionRequest {
  return {
    executionId,
    stepId: 'step-1',
    agentId: 'AG-101',
    inputs,
    policy: {
      timeoutMs: 5000,
      retry: { maxRetries: 2, retryable: true, backoffMs: 1 },
      failureBehavior: FailurePolicy.FailFast,
      continueOnFailure: false,
      stopOnFailure: true,
      fallbackAllowed: false,
      maxSteps: 1,
      maxTotalExecutionTimeMs: 20000,
    },
    traceId: 'trace-1',
  };
}

describe('derivation (exec_<requestId>)', () => {
  it('recovers the request id from an execution id', () => {
    expect(derivation('exec_req-123')).toBe('req-123');
  });

  it('falls back to the execution id when there is no prefix', () => {
    expect(derivation('req-123')).toBe('req-123');
  });

  it('keeps the whole remainder, including slashes', () => {
    expect(derivation('exec_alpha/beta')).toBe('alpha/beta');
  });
});

describe('MemoryAwareContextInputBuilder (Phase 5)', () => {
  it('resolves a load input when an actor binding exists with namespaces', () => {
    const actors = new RequestActorRegistry();
    actors.register({
      requestId: 'req-1',
      traceId: 'trace-1',
      actorGroup: MemoryActorGroup.Client,
      actorId: 'user:1',
      namespaces: ['user:1', 'workspace:alpha'],
    });
    const builder = new MemoryAwareContextInputBuilder({ actorRegistry: actors });
    const input = builder.build(request('exec_req-1', { 'request.input': 'create project' }));
    expect(input?.requestId).toBe('req-1');
    expect(input?.actorGroup).toBe(MemoryActorGroup.Client);
    expect(input?.namespaces).toEqual(['user:1', 'workspace:alpha']);
    expect(input?.query).toBe('create project');
    expect(input?.maxResults).toBe(5);
    expect(input?.traceId).toBe('trace-1');
  });

  it('returns undefined (fail-closed) when there is no binding', () => {
    const actors = new RequestActorRegistry();
    const builder = new MemoryAwareContextInputBuilder({ actorRegistry: actors });
    expect(builder.build(request('exec_req-9'))).toBeUndefined();
  });

  it('returns undefined (fail-closed) when the binding has no namespaces', () => {
    const actors = new RequestActorRegistry();
    actors.register({
      requestId: 'req-1',
      actorGroup: MemoryActorGroup.Client,
      namespaces: [],
    });
    const builder = new MemoryAwareContextInputBuilder({ actorRegistry: actors });
    expect(builder.build(request('exec_req-1'))).toBeUndefined();
  });

  it('omits a query for empty inputs', () => {
    const actors = new RequestActorRegistry();
    actors.register({
      requestId: 'req-1',
      actorGroup: MemoryActorGroup.Client,
      namespaces: ['user:1'],
    });
    const builder = new MemoryAwareContextInputBuilder({ actorRegistry: actors });
    const input = builder.build(request('exec_req-1', {}));
    expect(input?.query).toBeUndefined();
  });

  it('unregisters a binding so it no longer resolves', () => {
    const actors = new RequestActorRegistry();
    actors.register({
      requestId: 'req-1',
      actorGroup: MemoryActorGroup.Client,
      namespaces: ['user:1'],
    });
    actors.unregister('req-1');
    const builder = new MemoryAwareContextInputBuilder({ actorRegistry: actors });
    expect(builder.build(request('exec_req-1'))).toBeUndefined();
  });
});
