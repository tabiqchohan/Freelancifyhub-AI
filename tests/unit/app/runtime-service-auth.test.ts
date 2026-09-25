import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

async function startRuntime(serviceToken: string) {
  const env = parseCompiledEnv({ AIOS_SERVICE_TOKEN: serviceToken });
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

/**
 * Sprint 29 — server-to-server authentication boundary. When a service token
 * is configured, every business endpoint fail-closed (401) without it, while
 * liveness probes stay open for infrastructure health checks.
 */
describe('ProductionRuntime service-token auth (Sprint 29)', () => {
  it('rejects business endpoints without the service token', async () => {
    const { runtime, baseUrl } = await startRuntime('throwaway-service-token');
    try {
      const res = await fetch(`${baseUrl}/api/ai/status`, {
        headers: { 'x-aios-service-token': '' },
      });
      expect(res.status).toBe(401);
      const payload = (await res.json()) as { error: string };
      expect(payload.error).toBe('unauthorized');
    } finally {
      await runtime.shutdown();
    }
  });

  it('rejects business endpoints with a wrong service token', async () => {
    const { runtime, baseUrl } = await startRuntime('throwaway-service-token');
    try {
      const res = await fetch(`${baseUrl}/api/ai/status`, {
        headers: { 'x-aios-service-token': 'wrong-token' },
      });
      expect(res.status).toBe(401);
    } finally {
      await runtime.shutdown();
    }
  });

  it('accepts business endpoints with the configured service token', async () => {
    const { runtime, baseUrl } = await startRuntime('throwaway-service-token');
    try {
      const res = await fetch(`${baseUrl}/api/ai/status`, {
        headers: { 'x-aios-service-token': 'throwaway-service-token' },
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { enabled: boolean };
      expect(typeof payload.enabled).toBe('boolean');
    } finally {
      await runtime.shutdown();
    }
  });

  it('keeps liveness probes reachable without a token', async () => {
    const { runtime, baseUrl } = await startRuntime('throwaway-service-token');
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
    } finally {
      await runtime.shutdown();
    }
  });

  it('stays open when no service token is configured (dev default)', async () => {
    const { runtime, baseUrl } = await startRuntime('');
    try {
      const res = await fetch(`${baseUrl}/api/ai/status`);
      expect(res.status).toBe(200);
    } finally {
      await runtime.shutdown();
    }
  });
});
