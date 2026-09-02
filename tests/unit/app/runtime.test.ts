import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime, defaultHealth } from '../../../src/app/runtime.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

async function startRuntime() {
  const env = parseCompiledEnv({});
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  const composition = await createProductionComposition({ env });
  const runtime = createProductionRuntime({
    composition,
    logger: (await import('pino')).default({ level: 'silent' }),
  });
  const server = await runtime.start(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  return { runtime, composition, baseUrl: `http://127.0.0.1:${port}` };
}

describe('ProductionRuntime (Phase 7)', () => {
  it('serves liveness at /healthz', async () => {
    const { runtime, baseUrl } = await startRuntime();
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { status: string; storage: { healthy: boolean } };
      expect(payload.status).toBe('ok');
      expect(typeof payload.storage.healthy).toBe('boolean');
    } finally {
      await runtime.shutdown();
    }
  });

  it('serves /health as an alias', async () => {
    const { runtime, baseUrl } = await startRuntime();
    try {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
    } finally {
      await runtime.shutdown();
    }
  });

  it('routes a create-project request through the orchestrator to the runtime agent', async () => {
    const { runtime, baseUrl } = await startRuntime();
    try {
      const res = await fetch(`${baseUrl}/runtime/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'create project',
          actor: { group: 'CLIENT', id: 'user:1', namespaces: ['user:1'] },
        }),
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        route: { selectedAgent?: { agent?: { agentId?: string } } };
      };
      expect(payload.route?.selectedAgent?.agent?.agentId).toBe('AG-101');
    } finally {
      await runtime.shutdown();
    }
  });

  it('rejects an empty text body with 400', async () => {
    const { runtime, baseUrl } = await startRuntime();
    try {
      const res = await fetch(`${baseUrl}/runtime/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await runtime.shutdown();
    }
  });

  it('rejects invalid JSON with 400', async () => {
    const { runtime, baseUrl } = await startRuntime();
    try {
      const res = await fetch(`${baseUrl}/runtime/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      });
      expect(res.status).toBe(400);
    } finally {
      await runtime.shutdown();
    }
  });

  it('returns 404 for unknown paths', async () => {
    const { runtime, baseUrl } = await startRuntime();
    try {
      const res = await fetch(`${baseUrl}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe('defaultHealth (Phase 8)', () => {
  it('reports ok when storage is healthy and never exposes secrets', async () => {
    const payload = await defaultHealth(async () => ({ healthy: true }));
    expect(payload.status).toBe('ok');
    expect(payload.storage.healthy).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/postgres|neon|database_url/i);
  });

  it('reports degraded when storage is unhealthy', async () => {
    const payload = await defaultHealth(async () => ({ healthy: false }));
    expect(payload.status).toBe('degraded');
    expect(payload.storage.healthy).toBe(false);
  });
});
