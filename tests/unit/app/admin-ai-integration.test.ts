import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import { parseCompiledEnv } from '../../../src/app/env.js';
import {
  ADMIN_CAPABILITY_IDS,
  ADMIN_NEW_AGENT_IDS,
  ADMIN_SCOPES,
} from '../../../src/agents/admin-ai-team/constants.js';
import { parseAdminRequest } from '../../../src/agents/admin-ai-team/schemas.js';
import { AdminAIService } from '../../../src/agents/admin-ai-team/service.js';
import { AdminAIError, ADMIN_AI_ERROR_CODES } from '../../../src/agents/admin-ai-team/errors.js';

function inMemoryEnv(overrides: Record<string, string> = {}): ReturnType<typeof parseCompiledEnv> {
  const env = parseCompiledEnv(overrides);
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  return env;
}

function adminActor(overrides: Record<string, unknown> = {}) {
  return {
    actorId: 'admin-1',
    namespaces: ['admin'],
    role: 'Admin',
    adminScopes: [...ADMIN_SCOPES],
    ...overrides,
  };
}

function adminRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adminRequestId: `adm_${Math.random().toString(36).slice(2, 10)}`,
    correlationId: `corr_${Math.random().toString(36).slice(2, 10)}`,
    actor: adminActor(),
    input: {},
    ...overrides,
  };
}

describe('createProductionComposition - Admin AI Team (Sprint 25)', () => {
  it('registers all five admin agents and exposes the adminAi service', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    try {
      const registry = composition.services.platformRegistry;
      for (const agentId of ADMIN_NEW_AGENT_IDS) {
        expect(registry.getAgent(agentId)).toBeDefined();
        expect(composition.services.platformGateway.isPlatformManaged(agentId)).toBe(true);
        expect(composition.services.platformGateway.isToolAllowed(agentId, 'calculator')).toBe(
          false,
        );
      }
      expect(
        registry
          .getAgent('AG-501')
          ?.capabilities.some((c) => c.id === ADMIN_CAPABILITY_IDS.analytics),
      ).toBe(true);
      expect(
        registry.getAgent('AG-501')?.capabilities.some((c) => c.id === ADMIN_CAPABILITY_IDS.action),
      ).toBe(true);
      expect(
        registry.getAgent('AG-502')?.capabilities.some((c) => c.id === ADMIN_CAPABILITY_IDS.fraud),
      ).toBe(true);
      expect(
        registry.getAgent('AG-503')?.capabilities.some((c) => c.id === ADMIN_CAPABILITY_IDS.health),
      ).toBe(true);
      expect(
        registry.getAgent('AG-504')?.capabilities.some((c) => c.id === ADMIN_CAPABILITY_IDS.aiOps),
      ).toBe(true);
      expect(
        registry
          .getAgent('AG-505')
          ?.capabilities.some((c) => c.id === ADMIN_CAPABILITY_IDS.executive),
      ).toBe(true);
      expect(registry.lifecycleStateOf('AG-501')?.toString()).toBe('READY');
      expect(registry.lifecycleStateOf('AG-505')?.toString()).toBe('READY');
      expect(composition.services.adminAi).toBeInstanceOf(AdminAIService);
      expect(composition.services.adminAi.status().healthy).toBe(true);
      expect(composition.services.adminAi.status().enabled).toBe(true);
    } finally {
      await composition.storage.close();
    }
  });
});

describe('Admin AI Team runtime integration (Sprint 25)', () => {
  it('routes an admin analytics request end-to-end', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    const runtime = createProductionRuntime({
      composition,
      logger: (await import('pino')).default({ level: 'silent' }),
    });
    const server = await runtime.start(0, '127.0.0.1');
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/runtime/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'analytics query user signups trend',
          role: 'Admin',
          actor: {
            group: 'ADMIN',
            id: 'admin:1',
            namespaces: ['admin'],
          },
        }),
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        route: { selectedAgent?: { agent?: { agentId?: string } } };
        result?: { success?: boolean };
      };
      expect(payload.route?.selectedAgent?.agent?.agentId).toBe('AG-501');
    } finally {
      await runtime.shutdown();
      await composition.storage.close();
    }
  });

  it('exposes the admin-ai status endpoint with correct shape', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    const runtime = createProductionRuntime({
      composition,
      logger: (await import('pino')).default({ level: 'silent' }),
    });
    const server = await runtime.start(0, '127.0.0.1');
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin-ai/status`);
      expect(res.status).toBe(200);
      const payload = (await res.json()) as {
        name: string;
        version: string;
        healthy: boolean;
        enabled: boolean;
        agents: { ids: readonly string[]; active: number };
        workflows: readonly string[];
        metrics: { counters: Record<string, number> };
        events: { total: number };
      };
      expect(payload.name).toBe('admin-ai-service');
      expect(payload.version).toBe('1.0.0');
      expect(payload.healthy).toBe(true);
      expect(payload.enabled).toBe(true);
      expect(payload.agents.active).toBe(5);
      expect(payload.agents.ids).toHaveLength(5);
      expect(payload.workflows).toContain('admin.executive');
      expect(typeof payload.metrics.counters.requests).toBe('number');
      expect(payload.events.total).toBeGreaterThanOrEqual(0);
    } finally {
      await runtime.shutdown();
      await composition.storage.close();
    }
  });

  it('blocks admin requests without admin scopes via the service', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    try {
      const service = composition.services.adminAi;
      const result = await service.handle(
        parseAdminRequest(
          adminRequest({
            intent: 'admin.analytics',
            input: { analytics: { query: 'show users' } },
            actor: adminActor({ adminScopes: [] }),
          }),
        ),
      );
      expect(result.status).toBe('FAILED');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.code).toBe(ADMIN_AI_ERROR_CODES.UNAUTHORIZED);
    } finally {
      await composition.storage.close();
    }
  });

  it('blocks admin requests for unauthorized scope', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    try {
      const service = composition.services.adminAi;
      const result = await service.handle(
        parseAdminRequest(
          adminRequest({
            intent: 'admin.fraud',
            input: { fraud: { signals: [] } },
            actor: adminActor({ adminScopes: ['users'] }),
          }),
        ),
      );
      expect(result.status).toBe('FAILED');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.code).toBe(ADMIN_AI_ERROR_CODES.FORBIDDEN);
    } finally {
      await composition.storage.close();
    }
  });

  it('executes a single admin analytics request successfully', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    try {
      const service = composition.services.adminAi;
      const result = await service.handle(
        parseAdminRequest(
          adminRequest({
            intent: 'admin.analytics',
            input: {
              analytics: {
                query: 'project conversion rate',
                permittedDataset: [{ scope: 'projects', dataset: 'projects' }],
                facts: [{ name: 'conversion.rate', value: 0.32 }],
              },
            },
          }),
        ),
      );
      expect(result.status).toBe('COMPLETED');
      expect(result.routeKind).toBe('single');
      expect(result.agents).toContain('AG-501');
      const analytics = result.structuredData?.analytics as
        { dataSufficient?: boolean } | undefined;
      expect(analytics?.dataSufficient).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      await composition.storage.close();
    }
  });

  it('returns COMPLETED with no-data note for insufficient fraud input', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    try {
      const service = composition.services.adminAi;
      const result = await service.handle(
        parseAdminRequest(
          adminRequest({
            intent: 'admin.fraud',
            input: { fraud: { signals: [] } },
          }),
        ),
      );
      expect(result.status).toBe('COMPLETED');
      expect(result.agents).toContain('AG-502');
      const fraud = result.structuredData?.fraud as {
        dataSufficient?: boolean;
        note?: string;
      };
      expect(fraud?.dataSufficient).toBe(false);
      expect(typeof fraud?.note).toBe('string');
      expect(result.errors).toEqual([]);
    } finally {
      await composition.storage.close();
    }
  });

  it('rejects request with both intent and task missing', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    try {
      const service = composition.services.adminAi;
      try {
        const request = adminRequest({ intent: undefined, task: undefined });
        delete request.input;
        service.handle(parseAdminRequest(request));
        expect.unreachable('expected an invalid-input error');
      } catch (error) {
        expect(error).toBeInstanceOf(AdminAIError);
        expect((error as AdminAIError).code).toBe(ADMIN_AI_ERROR_CODES.INVALID_INPUT);
      }
    } finally {
      await composition.storage.close();
    }
  });
});
