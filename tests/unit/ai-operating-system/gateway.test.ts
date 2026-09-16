import { describe, expect, it, vi } from 'vitest';

import { AggregationStatus } from '../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import type { UserRole } from '../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { AiosErrorCode } from '../../../src/ai-operating-system/errors.js';
import { AiosGateway } from '../../../src/ai-operating-system/gateway.js';
import { AiosMetrics } from '../../../src/ai-operating-system/metrics.js';
import type { AiosPipeline } from '../../../src/ai-operating-system/pipeline.js';
import type { AiosService } from '../../../src/ai-operating-system/service.js';
import {
  AiosStage,
  type AiosRequest,
  type AiosResponse,
  type AiosStatus,
} from '../../../src/ai-operating-system/types.js';
import { DEFAULT_AIOS_CONFIG } from '../../../src/ai-operating-system/config.js';

const done: AiosResponse = {
  requestId: 'req-1',
  traceId: 'trace-1',
  status: AggregationStatus.Success,
  intent: 'project.create',
  response: 'done',
  stages: [AiosStage.Completed],
  execution: {
    target: { kind: 'client' },
    route: {
      intentId: 'project.create',
      supportedAgents: ['AG-101'],
      confidence: 1,
      target: { kind: 'client' },
    },
    intent: { primary: {} } as never,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    agents: ['AG-101'],
  },
};

function req(
  requestId: string,
  idempotencyKey?: string,
  metadata?: Readonly<Record<string, unknown>>,
): AiosRequest {
  return {
    requestId,
    traceId: `trace-${requestId}`,
    input: { text: 'create project new website' },
    actor: { actorId: 'u-1', role: 'Freelancer' as UserRole, namespaces: [] },
    options:
      idempotencyKey !== undefined || metadata !== undefined
        ? { idempotencyKey, metadata }
        : undefined,
  };
}

function stubService(): AiosService {
  return {
    lastResult: () =>
      done as unknown as AiosService['lastResult'] extends never ? never : undefined,
    isActive: () => false,
    activeCount: () => 0,
    cancel: vi.fn(),
  } as unknown as AiosService;
}

describe('AIOS gateway (Sprint 26)', () => {
  it('delegates to the pipeline and exposes bounded status snapshots', async () => {
    const pipeline = { execute: vi.fn(async () => done) } as unknown as AiosPipeline;
    const gateway = new AiosGateway({
      config: DEFAULT_AIOS_CONFIG,
      pipeline,
      service: stubService(),
      metrics: new AiosMetrics(),
    });

    const response = await gateway.request(req('req-ok'));
    expect(response).toEqual(done);
    expect(pipeline.execute).toHaveBeenCalledOnce();

    const requestStatus = gateway.status('req-ok');
    expect(requestStatus.enabled).toBe(true);
    expect(requestStatus.healthy).toBe(true);

    const overall = gateway.status();
    expect(overall).toMatchObject<Partial<AiosStatus>>({ enabled: true, healthy: true });
  });

  it('replays the completed response for the same idempotency key', async () => {
    const pipeline = { execute: vi.fn(async () => done) } as unknown as AiosPipeline;
    const gateway = new AiosGateway({
      config: DEFAULT_AIOS_CONFIG,
      pipeline,
      service: stubService(),
      metrics: new AiosMetrics(),
    });

    await gateway.request(req('req-idem-1', 'key-1'));
    const replay = await gateway.request(req('req-idem-1', 'key-1'));
    expect(replay).toEqual(done);
    expect(pipeline.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects an in-flight conflict for a different requestId under the same key', async () => {
    let release: (value: AiosResponse) => void = () => undefined;
    const gate = new Promise<AiosResponse>((resolve) => {
      release = resolve;
    });
    const pipeline = { execute: vi.fn(async () => gate) } as unknown as AiosPipeline;
    const gateway = new AiosGateway({
      config: DEFAULT_AIOS_CONFIG,
      pipeline,
      service: stubService(),
      metrics: new AiosMetrics(),
    });

    const first = gateway.request(req('req-a', 'key-2'));
    await expect(gateway.request(req('req-b', 'key-2'))).rejects.toMatchObject({
      code: AiosErrorCode.IdempotencyConflict,
    });
    release(done);
    await first;
    expect(pipeline.execute).toHaveBeenCalledTimes(1);
  });

  it('forwards cancel requests to the active-execution registry', () => {
    const service = stubService();
    const gateway = new AiosGateway({
      config: DEFAULT_AIOS_CONFIG,
      pipeline: { execute: vi.fn(async () => done) } as unknown as AiosPipeline,
      service,
      metrics: new AiosMetrics(),
    });
    gateway.cancel('req-cancel-1');
    expect(service.cancel as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('req-cancel-1');
  });

  it('clamps caller timeouts through the config ceiling', async () => {
    const seen: number[] = [];
    const pipeline = {
      execute: vi.fn(async (input: { options?: { timeoutMs?: number } }) => {
        seen.push(input.options?.timeoutMs ?? -1);
        return done;
      }),
    } as unknown as AiosPipeline;
    const gateway = new AiosGateway({
      config: { ...DEFAULT_AIOS_CONFIG, AIOS_REQUEST_TIMEOUT_MS: 5_000 },
      pipeline,
      service: stubService(),
      metrics: new AiosMetrics(),
    });

    await gateway.request(req('req-t1', undefined, { whatever: true }));
    await gateway.request(Object.assign(req('req-t2'), { options: { timeoutMs: 20_000 } }));
    expect(seen).toEqual([5_000, 5_000]);
  });
});
