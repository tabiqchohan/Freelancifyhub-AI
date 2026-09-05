import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionComposition } from '../../../src/app/composition-root.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

let runtime: ProductionRuntime;
let composition: ProductionComposition;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const env = parseCompiledEnv({});
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
    const res = await fetch(`${baseUrl}/api/tools?group=ORCHESTRATOR&ns=default`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; tools: { name: string }[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.tools.map((t) => t.name)).toContain('calculator');
  });

  it('executes the calculator successfully via POST /api/tools/calculator/execute', async () => {
    const res = await fetch(
      `${baseUrl}/api/tools/calculator/execute?group=ORCHESTRATOR&ns=default`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { expression: '2 + 3 * 4' } }),
      },
    );
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
    const res = await fetch(
      `${baseUrl}/api/tools/calculator/execute?group=ORCHESTRATOR&ns=default`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { expression: 'require(fs)' } }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('VALIDATION_FAILED');
  });

  it('returns 403 AUTHORIZATION_FAILED for a group lacking EXECUTE', async () => {
    const res = await fetch(`${baseUrl}/api/tools/calculator/execute?group=MARKETING&ns=default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { expression: '1+1' } }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('AUTHORIZATION_FAILED');
  });

  it('returns NOT_FOUND for an unknown tool', async () => {
    const res = await fetch(`${baseUrl}/api/tools/nope/execute?group=ORCHESTRATOR&ns=default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('disable prevents execution then enable restores it (management)', async () => {
    // Disable as ToolManager (the only group with DISABLE).
    const disable = await fetch(
      `${baseUrl}/api/tools/calculator/disable?group=TOOL_MANAGER&ns=default`,
      {
        method: 'POST',
      },
    );
    expect(disable.status).toBe(200);

    // A disabled tool is denied execution (reported as DISABLED, HTTP 422).
    const denied = await fetch(
      `${baseUrl}/api/tools/calculator/execute?group=ORCHESTRATOR&ns=default`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { expression: '1+1' } }),
      },
    );
    expect(denied.status).toBe(422);
    expect(((await denied.json()) as { status: string }).status).toBe('DISABLED');

    const enable = await fetch(
      `${baseUrl}/api/tools/calculator/enable?group=TOOL_MANAGER&ns=default`,
      {
        method: 'POST',
      },
    );
    expect(enable.status).toBe(200);

    const ok = await fetch(
      `${baseUrl}/api/tools/calculator/execute?group=ORCHESTRATOR&ns=default`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { expression: '6*7' } }),
      },
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { output: { result: number } }).output.result).toBe(42);
  });
});
