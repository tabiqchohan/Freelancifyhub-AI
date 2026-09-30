/**
 * Sprint 35 F-5 — internal error-text disclosure regression.
 *
 * Before the fix, `AiosService.failedCatcher` copied the raw `cause.message`
 * into the execution result, and `AiosGateway.requestStatus` republished it as
 * `lastFailure`. Any caller able to name a request id could therefore read
 * database driver text, provider responses, hostnames, file paths or connection
 * strings straight out of `/api/ai/status?requestId=...`.
 *
 * These tests pin the boundary: only the stable error code crosses it.
 */
import { describe, expect, it, vi } from 'vitest';

import { AggregationStatus } from '../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import type { UserRole } from '../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { AiosError, AiosErrorCode } from '../../../src/ai-operating-system/errors.js';
import { AiosGateway } from '../../../src/ai-operating-system/gateway.js';
import { AiosMetrics } from '../../../src/ai-operating-system/metrics.js';
import { AiosService } from '../../../src/ai-operating-system/service.js';
import type { AiosServiceDeps } from '../../../src/ai-operating-system/service.js';
import {
  AiosStage,
  type AiosExecutionTarget,
  type AiosResponse,
} from '../../../src/ai-operating-system/types.js';
import { DEFAULT_AIOS_CONFIG } from '../../../src/ai-operating-system/config.js';

/** Text that must never reach a client: driver, host, path and secret shaped. */
const SENSITIVE = [
  'connect ECONNREFUSED 10.0.4.19:5432',
  'C:\\Users\\svc\\aios\\secrets\\prod.env',
  'postgres://aios:hunter2@db.internal:5432/aios',
].join(' | ');

const target = { kind: 'orchestrator' } as AiosExecutionTarget;

function exec(target: AiosExecutionTarget) {
  return {
    requestId: 'req-f5',
    traceId: 'trace-f5',
    target,
    startedAtMs: 0,
  } as never;
}

function ctx(_target: AiosExecutionTarget) {
  return {
    requestId: 'req-f5',
    traceId: 'trace-f5',
    input: { text: 'create project' },
    actor: { actorId: 'u-1', role: 'Freelancer' as UserRole, namespaces: [] },
    intent: { primary: {} } as never,
    options: {},
    deadline: { signal: new AbortController().signal, deadlineAtMs: 0 },
    stage: AiosStage.Execute,
  } as never;
}

function serviceThatFailsWith(cause: unknown): AiosService {
  return new AiosService({
    orchestrator: {
      execute: async () => {
        throw cause;
      },
      cancel: async () => undefined,
    },
  } as unknown as AiosServiceDeps);
}

describe('Sprint 35 F-5 — internal error text must not cross the AIOS boundary', () => {
  it('replaces a raw driver/host error message with a bounded safe message', async () => {
    const service = serviceThatFailsWith(new Error(SENSITIVE));
    const catcher = await service.dispatch(ctx(target), exec(target));

    expect(catcher.status).toBe(AggregationStatus.Failed);
    expect(catcher.error?.code).toBe(AiosErrorCode.ExecutionFailed);
    expect(catcher.error?.message).toBe('Request failed');

    // No fragment of the internal text survives anywhere on the result.
    const serialized = JSON.stringify(catcher);
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('10.0.4.19');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('prod.env');
  });

  it('keeps a typed AiosError code but still hides its internal message', async () => {
    const service = serviceThatFailsWith(
      new AiosError(AiosErrorCode.DeadlineExceeded, SENSITIVE, { requestId: 'req-f5' }),
    );
    const catcher = await service.dispatch(ctx(target), exec(target));

    // The stable code is caller-safe and is preserved for programmatic use.
    expect(catcher.error?.code).toBe(AiosErrorCode.DeadlineExceeded);
    expect(catcher.error?.message).toBe('Request exceeded its deadline');
    expect(JSON.stringify(catcher)).not.toContain('hunter2');
  });

  it('publishes only the error code as lastFailure on per-request status', async () => {
    const service = serviceThatFailsWith(new Error(SENSITIVE));
    const catcher = await service.dispatch(ctx(target), exec(target));
    expect(catcher.status).toBe(AggregationStatus.Failed);

    const gateway = new AiosGateway({
      config: DEFAULT_AIOS_CONFIG,
      pipeline: { execute: vi.fn() } as never,
      service: service as never,
      metrics: new AiosMetrics(),
    });

    const status = gateway.status('req-f5');

    // Regression: `lastFailure` used to be `result.error.message`, i.e. the raw
    // internal text. It is now the stable code.
    expect(status.lastFailure).toBe(AiosErrorCode.ExecutionFailed);
    expect(JSON.stringify(status)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(status)).not.toContain('hunter2');
  });

  it('leaves lastFailure undefined for a successful request', async () => {
    const ok: AiosResponse = {
      requestId: 'req-ok',
      traceId: 'trace-ok',
      status: AggregationStatus.Success,
      intent: 'project.create',
      response: 'done',
      stages: [AiosStage.Completed],
      execution: {
        target: { kind: 'orchestrator' },
        route: {
          intentId: 'project.create',
          supportedAgents: ['AG-001'],
          confidence: 1,
          target: { kind: 'orchestrator' },
        },
        intent: { primary: {} } as never,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1000,
        agents: ['AG-001'],
      },
    };
    const service = {
      lastResult: vi.fn(() => ok as never),
      isActive: vi.fn(() => false),
      activeCount: vi.fn(() => 0),
      cancel: vi.fn(),
    } as unknown as AiosService;

    const gateway = new AiosGateway({
      config: DEFAULT_AIOS_CONFIG,
      pipeline: { execute: vi.fn() } as never,
      service,
      metrics: new AiosMetrics(),
    });

    expect(gateway.status('req-ok').lastFailure).toBeUndefined();
  });
});
