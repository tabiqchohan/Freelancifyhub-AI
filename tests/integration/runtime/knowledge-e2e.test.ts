import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionComposition } from '../../../src/app/composition-root.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

type KnowledgeDocJson = {
  id: string;
  title: string;
  content: string;
  namespace: string;
  version: number;
  lifecycle: string;
};

let runtime: ProductionRuntime;
let composition: ProductionComposition;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const env = parseCompiledEnv({});
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  env.knowledge.KNOWLEDGE_STORAGE_BACKEND = 'in-memory';
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

describe('AG-003 E2E - knowledge API over the production runtime', () => {
  it('creates a knowledge document via POST /api/knowledge', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Contract best practices',
        content: 'Always define scope, milestones, and payment terms clearly.',
        namespace: 'e2e-kn',
        securityLevel: 'INTERNAL',
      }),
    });
    expect(res.status).toBe(201);
    const doc = (await res.json()) as KnowledgeDocJson;
    expect(doc.id).toMatch(/^knowledge_/);
    expect(doc.version).toBe(1);
    expect(doc.lifecycle).toBe('ACTIVE');
    expect(doc.namespace).toBe('e2e-kn');
  });

  it('searches for matching knowledge via GET /api/knowledge?query=', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge?query=scope&ns=e2e-kn`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; documents: KnowledgeDocJson[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.documents[0]?.title).toBe('Contract best practices');
  });

  it('returns a document by id via GET /api/knowledge/:id', async () => {
    const createRes = await fetch(`${baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Fetch by id doc',
        content: 'This document is fetched directly by its unique identifier.',
        namespace: 'e2e-kn',
      }),
    });
    const created = (await createRes.json()) as KnowledgeDocJson;
    const res = await fetch(`${baseUrl}/api/knowledge/${created.id}`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as KnowledgeDocJson;
    expect(doc.id).toBe(created.id);
    expect(doc.title).toBe('Fetch by id doc');
  });

  it('returns 404 for an unknown knowledge id', async () => {
    const res = await fetch(`${baseUrl}/api/knowledge/knowledge_does_not_exist`);
    expect(res.status).toBe(404);
  });

  it('healthz reports knowledge storage health without leaking secrets', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      storage: { healthy: boolean };
      knowledge: { healthy: boolean };
    };
    expect(body.knowledge.healthy).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/postgres|neon|database_url|:\/\/(\w+):/i);
  });
});
