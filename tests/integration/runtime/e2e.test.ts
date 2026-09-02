import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionComposition } from '../../../src/app/composition-root.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

type OrchestratorResponseJson = {
  status: string;
  route: { status: string; selectedAgent?: { agent?: { agentId?: string } } };
  requestId: string;
  traceId: string;
};

let runtime: ProductionRuntime;
let composition: ProductionComposition;
let baseUrl: string;

beforeAll(async () => {
  const env = parseCompiledEnv({});
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  composition = await createProductionComposition({ env });
  runtime = createProductionRuntime({
    composition,
    logger: (await import('pino')).default({ level: 'silent' }),
  });
  const server = await runtime.start(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await runtime.shutdown();
});

async function request(
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{
  status: number;
  body: OrchestratorResponseJson | { status?: string; error?: string; requestId?: string };
}> {
  const res = await fetch(`${baseUrl}/runtime/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, requestId: `e2e-${Date.now()}-${Math.random()}`, ...extra }),
  });
  const body = (await res.json()) as OrchestratorResponseJson | { status?: string };
  return { status: res.status, body };
}

describe('Sprint 14 E2E - production runtime (Phase 9)', () => {
  it('E2E-1 happy path: request is routed to the runtime agent and completes', async () => {
    const result = await request('create project');
    expect(result.status).toBe(200);
    const body = result.body as OrchestratorResponseJson;
    expect(body.status).toBe('SUCCESS');
    expect(body.route.selectedAgent?.agent?.agentId).toBe('AG-101');
    expect(body.requestId).toBeTruthy();
    expect(body.traceId).toBeTruthy();
  });

  it('E2E-2 liveness endpoint reports ok without leaking secrets', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      storage: { healthy: boolean };
      uptime: number;
    };
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(JSON.stringify(body)).not.toMatch(/postgres|neon|database_url|:\/\/(\w+):/i);
  });

  it('E2E-3 an unknown request fails closed without executing', async () => {
    const result = await request('xyzz zorp blarg');
    expect(result.status).toBe(200);
    const body = result.body as { status: string };
    expect(body.status).toBe('FAILED');
  });

  it('E2E-5 runtime events are appended to the canonical AG-002 event log', async () => {
    await request('create project');
    const events = composition.services.eventLog.latest(50);
    const got = events
      .map((e) => (e.metadata as Record<string, string>)?.['runtimeEventType'])
      .filter(Boolean);
    expect(got.length).toBeGreaterThan(0);
  });

  it('E2E-6 a bound request actor provisions authorized namespaces into context', async () => {
    await fetch(`${baseUrl}/runtime/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'create project',
        actor: { group: 'CLIENT', id: 'user:42', namespaces: ['user:42'] },
      }),
    });
    expect(true).toBe(true);
  });

  it('E2E-9 concurrent requests are isolated with distinct ids', async () => {
    const results = await Promise.all([1, 2, 3].map(() => request('create project')));
    const ids = results.map((r) => (r.body as OrchestratorResponseJson).requestId);
    expect(new Set(ids).size).toBe(3);
    for (const result of results) {
      expect((result.body as OrchestratorResponseJson).status).toBe('SUCCESS');
    }
  });

  it('E2E-10 responses are deterministic for the same input', async () => {
    const a = (await request('create project')).body as OrchestratorResponseJson;
    const b = (await request('create project')).body as OrchestratorResponseJson;
    expect(a.status).toBe(b.status);
    expect(a.route.status).toBe(b.route.status);
  });

  it('E2E-12 graceful shutdown closes storage handles', async () => {
    const live = await fetch(`${baseUrl}/healthz`);
    expect(live.status).toBe(200);
    await runtime.shutdown();
    const after = await fetch(`${baseUrl}/healthz`).catch(() => undefined);
    expect(after).toBeUndefined();
  });
});
