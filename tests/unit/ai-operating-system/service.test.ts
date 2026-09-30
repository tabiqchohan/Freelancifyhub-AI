import { describe, expect, it } from 'vitest';

import { AggregationStatus } from '../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import { AiosError, AiosErrorCode } from '../../../src/ai-operating-system/errors.js';
import type { ExecutionContext } from '../../../src/ai-operating-system/execution-context.js';
import { normalizeExecutionResult } from '../../../src/ai-operating-system/execution-result.js';
import type { RequestContext } from '../../../src/ai-operating-system/request-context.js';
import type { AiosServiceDeps } from '../../../src/ai-operating-system/service.js';
import { AiosService } from '../../../src/ai-operating-system/service.js';
import type { AiosExecutionTarget } from '../../../src/ai-operating-system/types.js';

function exec(target: AiosExecutionTarget, timeoutMs = 5_000): ExecutionContext {
  return {
    requestId: 'req-1',
    traceId: 'trace-1',
    target,
    intentId: 'project.create',
    timeoutMs,
    deadlineAt: Date.now() + timeoutMs,
    startedAtMs: Date.now(),
    controller: new AbortController(),
    cancellation: {
      requested: false,
      signal: new AbortController().signal,
    },
    plan: { target: target.kind, agents: ['AG-101'], steps: ['execute'] },
    metadata: {},
  };
}

function ctx(target: AiosExecutionTarget, requestId = 'req-1'): RequestContext {
  return {
    target,
    requestId,
    traceId: 'trace-1',
    input: { text: 'create project new website' },
    actor: {
      actorId: 'u-1',
      role: 'Freelancer' as RequestContext['actor']['role'],
      namespaces: ['community'],
    },
    route: { intentId: 'project.create' },
    metadata: {},
  } as unknown as RequestContext;
}

const orchestratorStub = {
  execute: async () =>
    normalizeExecutionResult(
      { kind: 'orchestrator' } as AiosExecutionTarget,
      { status: AggregationStatus.Success, responseText: 'ok' } as never,
      Date.now(),
    ),
  cancel: async () => undefined,
};

const teamStub = {
  handle: async () => ({
    status: 'SUCCESS',
    response: 'client done',
    agents: ['AG-101'],
    confidence: 0.9,
  }),
};

function deps(overrides: Partial<AiosServiceDeps> = {}): AiosServiceDeps {
  return {
    orchestrator: orchestratorStub,
    clientAi: teamStub,
    freelancerAi: teamStub,
    marketplaceAi: teamStub,
    marketingAi: teamStub,
    adminAi: teamStub,
    ...overrides,
  } as unknown as AiosServiceDeps;
}

describe('AIOS execution service error preservation (Sprint 33)', () => {
  it('records a failed catcher carrying the tail error instead of a success-shaped result', async () => {
    const failed = new AiosError(AiosErrorCode.ExecutionFailed, 'tail exploded', {
      requestId: 'req-1',
    });
    const service = new AiosService(
      deps({
        orchestrator: {
          execute: async () => {
            throw failed;
          },
          cancel: async () => undefined,
        },
      } as unknown as AiosServiceDeps),
    );
    const target = { kind: 'orchestrator' } as AiosExecutionTarget;
    const catcher = await service.dispatch(ctx(target), exec(target));
    expect(catcher.status).toBe(AggregationStatus.Failed);
    expect(catcher.error?.code).toBe(AiosErrorCode.ExecutionFailed);
    // Sprint 35 F-5 — the internal message 'tail exploded' must not reach the
    // caller; only the stable code and a bounded safe message are published.
    expect(catcher.error?.message).toBe('Request failed');
    expect(catcher.error?.message).not.toContain('tail exploded');
    expect(service.lastResult('req-1')).toBe(catcher);
  });

  it('returns a timed-out catcher when the tail exceeds the deadline', async () => {
    const service = new AiosService(
      deps({
        orchestrator: {
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return { status: AggregationStatus.Success } as never;
          },
          cancel: async () => undefined,
        },
      } as unknown as AiosServiceDeps),
    );
    const target = { kind: 'orchestrator' } as AiosExecutionTarget;
    const catcher = await service.dispatch(ctx(target), exec(target, 10));
    expect(catcher.status).toBe(AggregationStatus.TimedOut);
    expect(catcher.error?.code).toBe(AiosErrorCode.DeadlineExceeded);
  });

  it('removes the request from the active registry after dispatch', async () => {
    const service = new AiosService(deps());
    const target = { kind: 'client' } as AiosExecutionTarget;
    expect(service.isActive('req-1')).toBe(false);
    const result = service.dispatch(ctx(target), exec(target));
    expect(service.isActive('req-1')).toBe(true);
    await result;
    expect(service.isActive('req-1')).toBe(false);
  });

  it('keeps completed-request retention bounded (evicts oldest beyond the cap)', async () => {
    const service = new AiosService(deps());
    const target = { kind: 'client' } as AiosExecutionTarget;
    for (let i = 0; i < 1_010; i += 1) {
      const id = `req-${i}`;
      await service.dispatch(ctx(target, id), exec(target));
    }
    await service.dispatch(ctx(target, 'req-first'), exec(target));
    await service.dispatch(ctx(target, 'req-last'), exec(target));
    expect(service.lastResult('req-first')).toBeDefined();
    expect(service.lastResult('req-last')).toBeDefined();
  });
});

describe('AIOS execution service team dispatch (Sprint 33)', () => {
  it('normalizes a client team response into a success catcher', async () => {
    const service = new AiosService(deps());
    const target = { kind: 'client' } as AiosExecutionTarget;
    const catcher = await service.dispatch(ctx(target), exec(target));
    expect(catcher.status).toBe(AggregationStatus.Success);
    expect(catcher.responseText).toBe('client done');
  });

  it('produces a failed catcher when the team tail throws', async () => {
    const service = new AiosService(
      deps({
        clientAi: {
          handle: async () => {
            throw new Error('client tail failed');
          },
        },
      } as unknown as AiosServiceDeps),
    );
    const target = { kind: 'client' } as AiosExecutionTarget;
    const catcher = await service.dispatch(ctx(target), exec(target));
    expect(catcher.status).toBe(AggregationStatus.Failed);
    // Sprint 35 F-5 — an arbitrary thrown Error is an internal failure, so the
    // message is replaced with the bounded safe string rather than echoed.
    expect(catcher.error?.code).toBe(AiosErrorCode.ExecutionFailed);
    expect(catcher.error?.message).toBe('Request failed');
    expect(catcher.error?.message).not.toContain('client tail failed');
    expect(service.lastResult('req-1')).toBe(catcher);
  });
});

describe('AIOS execution service in-flight guard (Sprint 34)', () => {
  it('rejects a second dispatch while the same requestId is still active', async () => {
    const service = new AiosService(deps());
    const target = { kind: 'client' } as AiosExecutionTarget;
    // Dispatch is synchronous up to the in-flight guard, so create all three
    // promises before awaiting any of them.
    const first = service.dispatch(ctx(target), exec(target));
    expect(service.isActive('req-1')).toBe(true);
    const second = service.dispatch(ctx(target), exec(target));
    const third = service.dispatch(ctx(target), exec(target));
    await expect(second).rejects.toBeInstanceOf(AiosError);
    await expect(third).rejects.toMatchObject({ code: AiosErrorCode.IdempotencyConflict });
    await first;
    expect(service.isActive('req-1')).toBe(false);
  });

  it('allows re-dispatch once the previous execution has completed', async () => {
    const service = new AiosService(deps());
    const target = { kind: 'client' } as AiosExecutionTarget;
    await service.dispatch(ctx(target), exec(target));
    const catcher = await service.dispatch(ctx(target), exec(target));
    expect(catcher.status).toBe(AggregationStatus.Success);
  });
});
