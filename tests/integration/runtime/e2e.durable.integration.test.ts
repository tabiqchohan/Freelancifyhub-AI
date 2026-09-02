import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionComposition } from '../../../src/app/composition-root.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

const DATABASE_URL = process.env.MEMORY_DATABASE_URL;
const cn = DATABASE_URL && DATABASE_URL.trim().length > 0 ? describe : describe.skip;

cn('Sprint 14 E2E - durable production runtime (Phase 9, Postgres-gated)', () => {
  let runtime: ProductionRuntime;
  let composition: ProductionComposition;
  let baseUrl: string;

  beforeAll(async () => {
    const env = parseCompiledEnv();
    env.memory.MEMORY_STORAGE_BACKEND = 'durable';
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

  it('boots a durable composition and serves a create-project request', async () => {
    expect(composition.storage.durable).toBe(true);
    const res = await fetch(`${baseUrl}/runtime/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'create project' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('SUCCESS');
  });

  it('mirrors runtime events into the durable Postgres event log', async () => {
    const before = composition.services.eventLog.latest(50).length;
    await fetch(`${baseUrl}/runtime/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'create project' }),
    });
    const after = composition.services.eventLog.latest(50).length;
    expect(after).toBeGreaterThan(before);
  });
});
