import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import { parseCompiledEnv } from '../../../src/app/env.js';
import type { ProductionComposition } from '../../../src/app/composition-root.js';
import type { ProductionRuntime } from '../../../src/app/runtime.js';

function inMemoryEnv(overrides: Record<string, string> = {}): ReturnType<typeof parseCompiledEnv> {
  const env = parseCompiledEnv(overrides);
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  return env;
}

interface AiosJsonResponse {
  readonly status?: string;
  readonly intent?: string;
  readonly error?: string;
  readonly stages?: readonly string[];
  readonly execution?: { readonly target?: { readonly kind?: string }; readonly route?: unknown };
  readonly response?: string;
  readonly requestId?: string;
  readonly enabled?: boolean;
  readonly healthy?: boolean;
  readonly activeRequests?: number;
  readonly completedRequests?: number;
  readonly requestCounts?: Readonly<Record<string, number>>;
  readonly statusCounts?: Readonly<Record<string, number>>;
}

const pinoReady = (async () => (await import('pino')).default({ level: 'silent' }))();

describe('AI Operating System runtime integration (Sprint 26)', () => {
  let composition: ProductionComposition;
  let runtime: ProductionRuntime;
  let baseUrl: string;

  beforeAll(async () => {
    composition = await createProductionComposition({ env: inMemoryEnv() });
    runtime = createProductionRuntime({ composition, logger: await pinoReady });
    const server = await runtime.start(0, '127.0.0.1');
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 60_000);

  afterAll(async () => {
    await runtime.shutdown();
    await composition.storage.close();
  }, 20_000);

  async function post(
    path: string,
    body: unknown,
  ): Promise<{ status: number; payload: AiosJsonResponse }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, payload: (await res.json()) as AiosJsonResponse };
  }

  function aiosBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const requestId = `it-${Math.random().toString(36).slice(2, 12)}`;
    return {
      requestId,
      text: 'create project new website',
      role: 'Freelancer',
      actorId: 'it-user',
      namespaces: ['community'],
      ...overrides,
    };
  }

  it('exposes the aiOperatingSystem block on /health', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const health = (await res.json()) as {
      aiOperatingSystem?: AiosJsonResponse;
      status?: string;
    };
    expect(health.aiOperatingSystem).toBeDefined();
    expect(health.aiOperatingSystem?.enabled).toBe(true);
    expect(health.aiOperatingSystem?.healthy).toBe(true);
    expect(health.aiOperatingSystem?.requestCounts).toBeDefined();
    expect(health.aiOperatingSystem?.statusCounts).toBeDefined();
  });

  it('routes a client project.create request end-to-end to SUCCESS', async () => {
    const { status, payload } = await post('/api/ai/request', aiosBody());
    expect(status).toBe(200);
    expect(payload.intent).toBe('project.create');
    expect(payload.status).toBe('SUCCESS');
    expect(payload.execution?.target?.kind).toBe('client');
    expect(payload.stages?.[0]).toBe('VALIDATE');
    expect(payload.stages?.at(-1)).toBe('FINALIZE_RESPONSE');
    expect(payload.stages?.length).toBeGreaterThanOrEqual(12);
    expect(payload.requestId).toMatch(/^it-/);
  });

  it('routes a freelancer proposal request end-to-end to SUCCESS', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({ text: 'write me a proposal for the client project', role: 'Freelancer' }),
    );
    expect(status).toBe(200);
    expect(payload.intent).toBe('proposal.generate');
    expect(payload.status).toBe('SUCCESS');
    expect(payload.execution?.target?.kind).toBe('freelancer');
  });

  it('routes a marketing research request end-to-end to SUCCESS', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({ text: 'marketing research competitor analysis', role: 'Client' }),
    );
    expect(status).toBe(200);
    expect(payload.intent).toBe('marketing.research');
    expect(payload.status).toBe('SUCCESS');
    expect(payload.execution?.target?.kind).toBe('marketing');
  });

  it('routes a marketplace contract.generate request end-to-end to SUCCESS', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({ text: 'generate contract for the milestone plan', role: 'Client' }),
    );
    expect(status).toBe(200);
    expect(payload.intent).toBe('contract.generate');
    expect(payload.status).toBe('SUCCESS');
    expect(payload.execution?.target?.kind).toBe('marketplace');
  });

  it('routes an admin analytics request end-to-end to SUCCESS', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({
        text: 'analytics query platform trend',
        role: 'Admin',
        adminScopes: ['users'],
      }),
    );
    expect(status).toBe(200);
    expect(payload.intent).toBe('admin.analytics');
    expect(payload.status).toBe('SUCCESS');
    expect(payload.execution?.target?.kind).toBe('admin');
  });

  it('routes knowledge.search through the orchestrator tail', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({ text: 'search knowledge base about onboarding', role: 'Freelancer' }),
    );
    expect(status).toBe(200);
    expect(payload.intent).toBe('knowledge.search');
    expect(payload.status).toBe('SUCCESS');
    expect(payload.execution?.target?.kind).toBe('orchestrator');
  });

  it('routes platform.help through the orchestrator tail', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({ text: 'how do i reset my password', role: 'Freelancer' }),
    );
    expect(status).toBe(200);
    expect(payload.intent).toBe('platform.help');
    expect(payload.status).toBe('SUCCESS');
    expect(payload.execution?.target?.kind).toBe('orchestrator');
  });

  it('produces a deterministic PARTIAL when the team deadline is exceeded', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({
        text: 'create project new website',
        metadata: { 'aios.delayMs': 5000, 'aios.taskTimeoutMs': 1000 },
        timeoutMs: 30_000,
      }),
    );
    expect(status).toBe(200);
    expect(payload.intent).toBe('project.create');
    expect(payload.status).toBe('PARTIAL');
    expect(payload.execution?.target?.kind).toBe('client');
  }, 20_000);

  it('produces a deterministic TIMED_OUT when the AIOS deadline wins the race', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({
        text: 'create project new website',
        metadata: { 'aios.delayMs': 5000, 'aios.taskTimeoutMs': 5000 },
        timeoutMs: 150,
      }),
    );
    expect(status).toBe(200);
    expect(payload.intent).toBe('project.create');
    expect(payload.status).toBe('TIMED_OUT');
    expect(payload.response).toMatch(/deadline/i);
  }, 20_000);

  it('produces a deterministic CANCELLED when the gateway aborts mid-flight', async () => {
    const requestId = `it-cancel-${Math.random().toString(36).slice(2, 10)}`;
    const dispatched = post(
      '/api/ai/request',
      aiosBody({
        requestId,
        text: 'create project new website',
        metadata: { 'aios.delayMs': 5000, 'aios.taskTimeoutMs': 5000 },
        timeoutMs: 30_000,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    composition.services.aios.cancel(requestId);
    const { status, payload } = await dispatched;
    expect(status).toBe(200);
    expect(payload.intent).toBe('project.create');
    expect(payload.status).toBe('CANCELLED');

    const statusRes = composition.services.aios.status(requestId);
    expect(statusRes.completedRequests).toBe(1);
    expect(statusRes.statusCounts?.CANCELLED).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('replays an idempotent retry against the same key and request', async () => {
    const requestId = 'it-idem-ok';
    const body = aiosBody({ requestId, idempotencyKey: 'it-key-ok' });
    const first = await post('/api/ai/request', body);
    const second = await post('/api/ai/request', body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.payload.status).toBe('SUCCESS');
    expect(second.payload.requestId).toBe(requestId);
    expect(second.payload.intent).toBe(first.payload.intent);
  });

  it('rejects a concurrent idempotency-key conflict with 409', async () => {
    const first = post(
      '/api/ai/request',
      aiosBody({
        requestId: 'it-idem-a',
        idempotencyKey: 'it-key-conflict',
        text: 'create project new website',
        metadata: { 'aios.delayMs': 1500, 'aios.taskTimeoutMs': 2000 },
        timeoutMs: 30_000,
      }),
    );
    const second = await post(
      '/api/ai/request',
      aiosBody({
        requestId: 'it-idem-b',
        idempotencyKey: 'it-key-conflict',
        text: 'create project new website',
        timeoutMs: 30_000,
      }),
    );
    expect(second.status).toBe(409);
    expect(second.payload.error).toBe('AIOS_IDEMPOTENCY_CONFLICT');
    await first;
  }, 20_000);

  it('fails closed on an undetectable intent with 422', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({ text: 'flibbertigibbet zyzzy plugh' }),
    );
    expect(status).toBe(422);
    expect(payload.error).toBe('AIOS_UNKNOWN_INTENT');
  });

  it('fails closed when inbound text carries a secret shape with 400', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({ text: 'create a project with token sk-ABCDEFGHIJKLMNOPQRST' }),
    );
    expect(status).toBe(400);
    expect(payload.error).toBe('AIOS_SECRET_DETECTED');
  });

  it('fails closed on payload size abuse (413) and empty text (400)', async () => {
    const oversize = await post('/api/ai/request', aiosBody({ text: 'a'.repeat(20_001) }));
    expect(oversize.status).toBe(413);
    expect(oversize.payload.error).toBe('AIOS_PAYLOAD_TOO_LARGE');

    const empty = await post('/api/ai/request', aiosBody({ text: '  ' }));
    expect(empty.status).toBe(400);
    expect(empty.payload.error).toBe('text_required');
  });

  it('denies a Guest reaching project features (403) and surfaces overall status', async () => {
    const { status, payload } = await post(
      '/api/ai/request',
      aiosBody({ text: 'view project', role: 'Guest' }),
    );
    expect(status).toBe(403);
    expect(payload.error).toBe('AIOS_UNAUTHORIZED_SCOPE');

    const res = await fetch(`${baseUrl}/api/ai/status`);
    expect(res.status).toBe(200);
    const overall = (await res.json()) as AiosJsonResponse;
    expect(overall.enabled).toBe(true);
    expect(overall.healthy).toBe(true);
    expect(Object.keys(overall.requestCounts ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(overall.statusCounts ?? {}).length).toBeGreaterThan(0);
  });

  it('exposes per-request status and handles cancel-input validation', async () => {
    const reqRes = await fetch(`${baseUrl}/api/ai/status?requestId=it-idem-ok`);
    expect(reqRes.status).toBe(200);
    const perRequest = (await reqRes.json()) as AiosJsonResponse;
    expect(perRequest.completedRequests).toBe(1);

    const missing = await post('/api/ai/cancel', {});
    expect(missing.status).toBe(400);
    expect(missing.payload.error).toBe('requestId_required');
  });
});
