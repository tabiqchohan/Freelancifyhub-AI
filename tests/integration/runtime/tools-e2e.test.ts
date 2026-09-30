import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionComposition } from '../../../src/app/composition-root.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

/**
 * Sprint 35 F-3/F-4 — the tools API is exercised with the real service boundary.
 *
 * A service token yields a trusted `service` caller (read + execute). Management
 * (enable/disable) requires the separate admin credential, so a caller can no
 * longer promote itself by naming an actor group in the query string.
 */
const SERVICE_TOKEN = 'throwaway-service-token';
const ADMIN_TOKEN = 'throwaway-admin-token';

let runtime: ProductionRuntime;
let composition: ProductionComposition;
let server: Server;
let baseUrl: string;

/** Headers for a trusted service caller. */
function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-aios-service-token': SERVICE_TOKEN, ...extra };
}

/** Headers for a trusted administrative caller (F-3). */
function adminHeaders(): Record<string, string> {
  return serviceHeaders({ 'x-aios-admin-token': ADMIN_TOKEN });
}

beforeAll(async () => {
  const env = parseCompiledEnv({
    AIOS_SERVICE_TOKEN: SERVICE_TOKEN,
    AIOS_ADMIN_TOKEN: ADMIN_TOKEN,
  });
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  env.knowledge.KNOWLEDGE_STORAGE_BACKEND = 'in-memory';
  env.tools.TOOLS_STORAGE_BACKEND = 'in-memory';
  composition = await createProductionComposition({ env });
  runtime = createProductionRuntime({
    composition,
    logger: (await import('pino')).default({ level: 'silent' }),
  });
  server = await runtime.start(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await runtime.shutdown();
});

describe('AG-004 E2E - tools API over the production runtime', () => {
  it('health reports tools healthy', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { healthy: boolean }; status: string };
    expect(body.tools.healthy).toBe(true);
    expect(body.status).toBe('ok');
  });

  it('lists registered tools including the calculator', async () => {
    const res = await fetch(`${baseUrl}/api/tools?ns=default`, { headers: serviceHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; tools: { name: string }[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.tools.map((t) => t.name)).toContain('calculator');
  });

  it('executes the calculator successfully via POST /api/tools/calculator/execute', async () => {
    const res = await fetch(`${baseUrl}/api/tools/calculator/execute?ns=default`, {
      method: 'POST',
      headers: serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ input: { expression: '2 + 3 * 4' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      output: { result: number };
      toolName: string;
    };
    expect(body.status).toBe('SUCCESS');
    expect(body.toolName).toBe('calculator');
    expect(body.output.result).toBe(14);
  });

  it('returns VALIDATION_FAILED for invalid calculator input', async () => {
    const res = await fetch(`${baseUrl}/api/tools/calculator/execute?ns=default`, {
      method: 'POST',
      headers: serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ input: { expression: 'require(fs)' } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('VALIDATION_FAILED');
  });

  it('returns NOT_FOUND for an unknown tool', async () => {
    const res = await fetch(`${baseUrl}/api/tools/nope/execute?ns=default`, {
      method: 'POST',
      headers: serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('requires a service token (Sprint 35 F-4)', async () => {
    const res = await fetch(`${baseUrl}/api/tools?ns=default`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
  });

  it('denies enable/disable to a service caller that names ADMIN in the query (Sprint 35 F-3)', async () => {
    // Regression: the caller-asserted `?group=ADMIN` used to be sufficient to
    // disable any registered tool. The actor group is now derived from the
    // credential, and management requires the admin credential.
    const res = await fetch(`${baseUrl}/api/tools/calculator/disable?group=ADMIN&ns=default`, {
      method: 'POST',
      headers: serviceHeaders(),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('forbidden');

    // The tool must still be enabled: the denied attack changed no state.
    const exec = await fetch(`${baseUrl}/api/tools/calculator/execute?ns=default`, {
      method: 'POST',
      headers: serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ input: { expression: '1+1' } }),
    });
    expect(exec.status).toBe(200);
  });

  it('denies enable/disable without any credential (Sprint 35 F-3/F-4)', async () => {
    const res = await fetch(`${baseUrl}/api/tools/calculator/disable?ns=default`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('disable prevents execution then enable restores it (admin credential)', async () => {
    const disable = await fetch(`${baseUrl}/api/tools/calculator/disable?ns=default`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(disable.status).toBe(200);

    // A disabled tool is denied execution (reported as DISABLED, HTTP 422).
    const denied = await fetch(`${baseUrl}/api/tools/calculator/execute?ns=default`, {
      method: 'POST',
      headers: serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ input: { expression: '1+1' } }),
    });
    expect(denied.status).toBe(422);
    expect(((await denied.json()) as { status: string }).status).toBe('DISABLED');

    const enable = await fetch(`${baseUrl}/api/tools/calculator/enable?ns=default`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(enable.status).toBe(200);

    const ok = await fetch(`${baseUrl}/api/tools/calculator/execute?ns=default`, {
      method: 'POST',
      headers: serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ input: { expression: '6*7' } }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { output: { result: number } }).output.result).toBe(42);
  });
});
