import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import {
  createProductionRuntime,
  defaultHealth,
  type HealthPayload,
} from '../../../src/app/runtime.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

async function startRuntime() {
  const env = parseCompiledEnv({});
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  const composition = await createProductionComposition({ env });
  const runtime = createProductionRuntime({
    composition,
    logger: (await import('pino')).default({ level: 'silent' }),
    // Sprint 35 F-4 — this suite exercises routing/AIOS behaviour, not
    // authentication, so it opts out of the fail-closed service token gate
    // explicitly instead of relying on the removed open-by-default behaviour.
    allowUnauthenticated: true,
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

  it('routes an AIOS request with a caller-supplied request id and echoes it back (Sprint 33)', async () => {
    const { runtime, baseUrl } = await startRuntime();
    try {
      const res = await fetch(`${baseUrl}/api/ai/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: 'req-abc-123',
          text: 'create project',
          role: 'Freelancer',
          actorId: 'user:1',
        }),
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { requestId: string; status: string };
      expect(payload.requestId).toBe('req-abc-123');
      expect(payload.status).toBe('SUCCESS');
    } finally {
      await runtime.shutdown();
    }
  });

  it('falls back to a tame random id for an unsafe caller-supplied request id (Sprint 33)', async () => {
    const { runtime, baseUrl } = await startRuntime();
    try {
      const res = await fetch(`${baseUrl}/api/ai/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: 'exec_other-request../../etc',
          text: 'create project',
          role: 'Freelancer',
          actorId: 'user:1',
        }),
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { requestId: string; status: string };
      expect(payload.requestId).toMatch(/^aios-/);
      expect(payload.requestId).not.toContain('other-request');
    } finally {
      await runtime.shutdown();
    }
  });

  it('serves pure liveness at /livez without dependency probing (Sprint 34)', async () => {
    const { runtime, composition, baseUrl } = await startRuntime();
    try {
      const live = await fetch(`${baseUrl}/livez`);
      expect(live.status).toBe(200);
      const payload = (await live.json()) as { status: string; uptime: number };
      expect(payload.status).toBe('ok');
      expect(typeof payload.uptime).toBe('number');
      expect(payload).not.toHaveProperty('storage');
      void composition;
    } finally {
      await runtime.shutdown();
    }
  });

  it('returns 503 readiness for a degraded health provider and 200 for healthy (Sprint 34)', async () => {
    const base = () => ({
      status: 'ok' as const,
      uptime: 1,
      storage: { healthy: true },
      knowledge: { healthy: true },
      tools: { healthy: true },
      llm: { enabled: false, configured: false, provider: 'disabled', model: '' },
      platform: {
        registered: 0,
        ready: 0,
        running: 0,
        paused: 0,
        draining: 0,
        disabled: 0,
        failed: 0,
        terminated: 0,
        activeExecutions: 0,
        healthy: true,
      },
      coordination: { healthy: true, activeCoordinations: 0, activeTaskCount: 0, eventCount: 0 },
      clientTeam: {
        healthy: true,
        enabled: false,
        activeAgents: 0,
        establishedAgents: 0,
        workflows: [],
        eventCount: 0,
      },
      freelancerTeam: {
        healthy: true,
        enabled: false,
        activeAgents: 0,
        establishedAgents: 0,
        workflows: [],
        eventCount: 0,
      },
      marketplaceTeam: {
        healthy: true,
        enabled: false,
        activeAgents: 0,
        establishedAgents: 0,
        workflows: [],
        eventCount: 0,
      },
      marketingTeam: {
        healthy: true,
        enabled: false,
        activeAgents: 0,
        establishedAgents: 0,
        workflows: [],
        eventCount: 0,
      },
      adminTeam: {
        healthy: true,
        enabled: false,
        activeAgents: 0,
        establishedAgents: 0,
        workflows: [],
        eventCount: 0,
      },
      aiOperatingSystem: {
        enabled: false,
        healthy: true,
        activeRequests: 0,
        completedRequests: 0,
        requestCounts: {},
        statusCounts: {},
      },
    });

    async function startReady(payload: {
      status: 'ok' | 'degraded';
      storage: { healthy: boolean };
    }) {
      const env = parseCompiledEnv({});
      env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
      const composition = await createProductionComposition({ env });
      const runtime = createProductionRuntime({
        composition,
        logger: (await import('pino')).default({ level: 'silent' }),
        healthCheck: () => Promise.resolve<HealthPayload>({ ...base(), ...payload }),
      });
      const server = await runtime.start(0, '127.0.0.1');
      const { port } = server.address() as AddressInfo;
      return { runtime, port };
    }

    const degraded = await startReady({ status: 'degraded', storage: { healthy: false } });
    try {
      const res = await fetch(`http://127.0.0.1:${degraded.port}/readyz`);
      expect(res.status).toBe(503);
      const payload = (await res.json()) as { status: string };
      expect(payload.status).toBe('degraded');
    } finally {
      await degraded.runtime.shutdown();
    }

    const healthy = await startReady({ status: 'ok', storage: { healthy: true } });
    try {
      const res = await fetch(`http://127.0.0.1:${healthy.port}/readyz`);
      expect(res.status).toBe(200);
    } finally {
      await healthy.runtime.shutdown();
    }
  });

  it('returns 503 with a timeout marker when the readiness probe hangs (Sprint 34)', async () => {
    const env = parseCompiledEnv({});
    env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
    const composition = await createProductionComposition({ env });
    const runtime = createProductionRuntime({
      composition,
      logger: (await import('pino')).default({ level: 'silent' }),
      healthCheck: () => new Promise<never>(() => undefined),
    });
    const server = await runtime.start(0, '127.0.0.1');
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(res.status).toBe(503);
      const payload = (await res.json()) as { error: string };
      expect(payload.error).toBe('readiness_probe_timeout');
    } finally {
      await runtime.shutdown();
    }
  });

  it('echoes a correlation request id header on responses (Sprint 34)', async () => {
    const { runtime, baseUrl } = await startRuntime();
    try {
      const res = await fetch(`${baseUrl}/livez`, {
        headers: { 'x-request-id': 'corr-123' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-request-id')).toBe('corr-123');
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
