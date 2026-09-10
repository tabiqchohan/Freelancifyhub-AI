import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

function inMemoryEnv(overrides: Record<string, string> = {}): ReturnType<typeof parseCompiledEnv> {
  const env = parseCompiledEnv(overrides);
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  return env;
}

describe('createProductionComposition - Agent Platform (Sprint 19)', () => {
  it('registers AG-101 + client AG-102..105 + freelancer AG-201/202/206/207 + marketplace AG-301..306 + marketing AG-401..405 + admin AG-501..505', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    try {
      const registry = composition.services.platformRegistry;
      expect(registry.getAgent('AG-101')?.name).toBe('Project Description Agent');
      expect(
        registry.getAgent('AG-102')?.capabilities.some((c) => c.id === 'budget.estimate'),
      ).toBe(true);
      expect(registry.getAgent('AG-105')?.capabilities.some((c) => c.id === 'project.score')).toBe(
        true,
      );
      expect(registry.getAgent('AG-201')?.capabilities.some((c) => c.id === 'proposal.draft')).toBe(
        true,
      );
      expect(
        registry.getAgent('AG-202')?.capabilities.some((c) => c.id === 'profile.analyze'),
      ).toBe(true);
      expect(registry.getAgent('AG-206')?.capabilities.some((c) => c.id === 'project.match')).toBe(
        true,
      );
      expect(
        registry.getAgent('AG-207')?.capabilities.some((c) => c.id === 'insight.analyze'),
      ).toBe(true);
      expect(
        registry.getAgent('AG-301')?.capabilities.some((c) => c.id === 'contract.generate'),
      ).toBe(true);
      expect(
        registry.getAgent('AG-301')?.capabilities.some((c) => c.id === 'project.quality'),
      ).toBe(true);
      expect(registry.getAgent('AG-302')?.capabilities.some((c) => c.id === 'milestone.plan')).toBe(
        true,
      );
      expect(registry.getAgent('AG-302')?.capabilities.some((c) => c.id === 'budget.analyze')).toBe(
        true,
      );
      expect(
        registry.getAgent('AG-303')?.capabilities.some((c) => c.id === 'review.generate'),
      ).toBe(true);
      expect(registry.getAgent('AG-304')?.capabilities.some((c) => c.id === 'scam.report')).toBe(
        true,
      );
      expect(
        registry.getAgent('AG-304')?.capabilities.some((c) => c.id === 'marketplace.insights'),
      ).toBe(true);
      expect(
        registry.getAgent('AG-304')?.capabilities.some((c) => c.id === 'marketplace.discovery'),
      ).toBe(true);
      expect(registry.getAgent('AG-305')?.capabilities.some((c) => c.id === 'dispute.open')).toBe(
        true,
      );
      expect(registry.getAgent('AG-306')?.capabilities.some((c) => c.id === 'message.send')).toBe(
        true,
      );
      expect(
        registry.getAgent('AG-401')?.capabilities.some((c) => c.id === 'marketing.research'),
      ).toBe(true);
      expect(
        registry.getAgent('AG-402')?.capabilities.some((c) => c.id === 'marketing.post.draft'),
      ).toBe(true);
      expect(
        registry.getAgent('AG-403')?.capabilities.some((c) => c.id === 'marketing.blog.draft'),
      ).toBe(true);
      expect(
        registry.getAgent('AG-404')?.capabilities.some((c) => c.id === 'marketing.seo.analyze'),
      ).toBe(true);
      expect(
        registry.getAgent('AG-405')?.capabilities.some((c) => c.id === 'marketing.email.draft'),
      ).toBe(true);
      expect(
        registry.getAgent('AG-501')?.capabilities.some((c) => c.id === 'admin.analytics'),
      ).toBe(true);
      expect(registry.getAgent('AG-501')?.capabilities.some((c) => c.id === 'admin.action')).toBe(
        true,
      );
      expect(registry.getAgent('AG-502')?.capabilities.some((c) => c.id === 'admin.fraud')).toBe(
        true,
      );
      expect(registry.getAgent('AG-503')?.capabilities.some((c) => c.id === 'admin.health')).toBe(
        true,
      );
      expect(registry.getAgent('AG-504')?.capabilities.some((c) => c.id === 'admin.aiops')).toBe(
        true,
      );
      expect(
        registry.getAgent('AG-505')?.capabilities.some((c) => c.id === 'admin.executive'),
      ).toBe(true);
      expect(registry.lifecycleStateOf('AG-101')?.toString()).toBe('READY');
      expect(registry.lifecycleStateOf('AG-102')?.toString()).toBe('READY');
      expect(registry.lifecycleStateOf('AG-202')?.toString()).toBe('READY');
      expect(registry.lifecycleStateOf('AG-304')?.toString()).toBe('READY');
      expect(registry.lifecycleStateOf('AG-401')?.toString()).toBe('READY');
      expect(registry.lifecycleStateOf('AG-405')?.toString()).toBe('READY');
      expect(registry.lifecycleStateOf('AG-501')?.toString()).toBe('READY');
      expect(registry.lifecycleStateOf('AG-505')?.toString()).toBe('READY');
      expect(registry.snapshot().registered).toBe(25);
      expect(registry.snapshot().ready).toBe(25);
      expect(composition.services.platformGateway.isPlatformManaged('AG-101')).toBe(true);
      expect(composition.services.platformGateway.isPlatformManaged('AG-001')).toBe(false);
      expect(composition.services.platformGateway.isToolAllowed('AG-101', 'calculator')).toBe(
        false,
      );
      // AG-102's mirror allowlists the calculator when tools are enabled.
      expect(composition.services.platformGateway.isToolAllowed('AG-102', 'calculator')).toBe(true);
      // Freelancer mirrors are managed but ship an empty tool allowlist (fail-closed).
      expect(composition.services.platformGateway.isPlatformManaged('AG-201')).toBe(true);
      expect(composition.services.platformGateway.isPlatformManaged('AG-207')).toBe(true);
      expect(composition.services.platformGateway.isToolAllowed('AG-201', 'calculator')).toBe(
        false,
      );
      expect(composition.services.platformGateway.isToolAllowed('AG-206', 'calculator')).toBe(
        false,
      );
      // Marketplace mirrors are managed with an empty tool allowlist (fail-closed).
      expect(composition.services.platformGateway.isPlatformManaged('AG-301')).toBe(true);
      expect(composition.services.platformGateway.isPlatformManaged('AG-306')).toBe(true);
      expect(composition.services.platformGateway.isToolAllowed('AG-301', 'calculator')).toBe(
        false,
      );
      expect(composition.services.platformGateway.isToolAllowed('AG-304', 'calculator')).toBe(
        false,
      );
      // Marketing mirrors are managed with an empty tool allowlist (fail-closed).
      expect(composition.services.platformGateway.isPlatformManaged('AG-401')).toBe(true);
      expect(composition.services.platformGateway.isPlatformManaged('AG-405')).toBe(true);
      expect(composition.services.platformGateway.isToolAllowed('AG-401', 'calculator')).toBe(
        false,
      );
      expect(composition.services.platformGateway.isToolAllowed('AG-405', 'calculator')).toBe(
        false,
      );
      // Admin mirrors are managed with an empty tool allowlist (fail-closed).
      expect(composition.services.platformGateway.isPlatformManaged('AG-501')).toBe(true);
      expect(composition.services.platformGateway.isPlatformManaged('AG-505')).toBe(true);
      expect(composition.services.platformGateway.isToolAllowed('AG-501', 'calculator')).toBe(
        false,
      );
      expect(composition.services.platformGateway.isToolAllowed('AG-504', 'calculator')).toBe(
        false,
      );
    } finally {
      await composition.storage.close();
    }
  });

  it('surfaces the platform block in /healthz', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    const runtime = createProductionRuntime({
      composition,
      logger: (await import('pino')).default({ level: 'silent' }),
    });
    const server = await runtime.start(0, '127.0.0.1');
    const { port } = server.address() as AddressInfo;
    try {
      const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as {
        platform: { registered: number; ready: number; running: number; healthy: boolean };
        clientTeam: {
          healthy: boolean;
          enabled: boolean;
          activeAgents: number;
          establishedAgents: number;
        };
        freelancerTeam: {
          healthy: boolean;
          enabled: boolean;
          activeAgents: number;
          establishedAgents: number;
        };
        marketplaceTeam: {
          healthy: boolean;
          enabled: boolean;
          activeAgents: number;
          establishedAgents: number;
        };
        marketingTeam: {
          healthy: boolean;
          enabled: boolean;
          activeAgents: number;
          establishedAgents: number;
        };
        adminTeam: {
          healthy: boolean;
          enabled: boolean;
          activeAgents: number;
          establishedAgents: number;
        };
      };
      expect(health.platform.registered).toBe(25);
      expect(health.platform.ready).toBe(25);
      expect(health.platform.running).toBe(0);
      expect(health.platform.healthy).toBe(true);
      expect(health.clientTeam.healthy).toBe(true);
      expect(health.clientTeam.enabled).toBe(true);
      expect(health.clientTeam.activeAgents).toBe(5);
      expect(health.clientTeam.establishedAgents).toBe(5);
      expect(health.freelancerTeam.healthy).toBe(true);
      expect(health.freelancerTeam.enabled).toBe(true);
      expect(health.freelancerTeam.activeAgents).toBe(4);
      expect(health.freelancerTeam.establishedAgents).toBe(4);
      expect(health.marketplaceTeam.healthy).toBe(true);
      expect(health.marketplaceTeam.enabled).toBe(true);
      expect(health.marketplaceTeam.activeAgents).toBe(6);
      expect(health.marketplaceTeam.establishedAgents).toBe(6);
      expect(health.marketingTeam.healthy).toBe(true);
      expect(health.marketingTeam.enabled).toBe(true);
      expect(health.marketingTeam.activeAgents).toBe(5);
      expect(health.marketingTeam.establishedAgents).toBe(5);
      expect(health.adminTeam.healthy).toBe(true);
      expect(health.adminTeam.enabled).toBe(true);
      expect(health.adminTeam.activeAgents).toBe(5);
      expect(health.adminTeam.establishedAgents).toBe(5);
      expect(JSON.stringify(health)).not.toMatch(/postgres|neon|database_url/i);
    } finally {
      await runtime.shutdown();
      await composition.storage.close();
    }
  });

  it('executes AG-101 through the platform gate end-to-end', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    try {
      const result = await composition.services.executor.execute({
        executionId: 'exec_platform_app-1',
        stepId: 'step-1',
        agentId: 'AG-101',
        inputs: { 'request.input': 'design a freight marketplace' },
        policy: {
          timeoutMs: 5000,
          retry: { maxRetries: 0, retryable: true, backoffMs: 1 },
          failureBehavior: 'fail_fast' as never,
          continueOnFailure: false,
          stopOnFailure: true,
          fallbackAllowed: false,
          maxSteps: 1,
          maxTotalExecutionTimeMs: 20000,
        },
        traceId: 'trace-platform-app-1',
      });
      expect(result.success).toBe(true);
      // Lease closed: lifecycle returns to READY with no residual slot.
      expect(composition.services.platformRegistry.lifecycleStateOf('AG-101')?.toString()).toBe(
        'READY',
      );
      expect(
        composition.services.platformRegistry.lifecycleController.activeExecutionCount('AG-101'),
      ).toBe(0);
    } finally {
      await composition.storage.close();
    }
  });

  it('fails closed when AG-101 is paused by the platform operator', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    composition.services.platformRegistry.pauseAgent('AG-101');
    try {
      const result = await composition.services.executor.execute({
        executionId: 'exec_platform_app-2',
        stepId: 'step-1',
        agentId: 'AG-101',
        inputs: { 'request.input': 'design a freight marketplace' },
        policy: {
          timeoutMs: 5000,
          retry: { maxRetries: 0, retryable: true, backoffMs: 1 },
          failureBehavior: 'fail_fast' as never,
          continueOnFailure: false,
          stopOnFailure: true,
          fallbackAllowed: false,
          maxSteps: 1,
          maxTotalExecutionTimeMs: 20000,
        },
        traceId: 'trace-platform-app-2',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('AGENT_NOT_READY');
      expect(
        composition.services.platformRegistry.lifecycleController.activeExecutionCount('AG-101'),
      ).toBe(0);
    } finally {
      await composition.storage.close();
    }
  });
});
