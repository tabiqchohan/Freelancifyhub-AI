import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import { parseCompiledEnv } from '../../../src/app/env.js';
import {
  CoordinationMode,
  TaskStatus,
} from '../../../src/agents/agent-platform/coordination/types.js';

function inMemoryEnv(overrides: Record<string, string> = {}): ReturnType<typeof parseCompiledEnv> {
  const env = parseCompiledEnv(overrides);
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  return env;
}

describe('createProductionComposition - Coordination layer (Sprint 20)', () => {
  it('runs a single-agent coordination end-to-end through the real executor', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    try {
      const result = await composition.services.coordination.coordinate({
        coordinationId: 'coord_app_1',
        correlationId: 'corr-app-1',
        requester: 'AG-001',
        objective: 'design a freight marketplace',
        mode: CoordinationMode.Single,
        tasks: [
          {
            taskId: 't1',
            agentId: 'AG-101',
            objective: 'design a freight marketplace',
            retry: {
              maxRetries: 0,
              retryable: true,
              backoffMs: 0,
              backoffMultiplier: 1,
              maxBackoffMs: 0,
            },
          },
        ],
      });
      expect(result.status).toBe('COMPLETED');
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.status).toBe(TaskStatus.Completed);
      expect(result.error).toBeUndefined();
      expect(composition.services.coordination.status().healthy).toBe(true);
      const eventLog = composition.services.coordinationEventLog;
      expect(eventLog.latest(20).some((e) => e.type === 'COORDINATION_COMPLETED')).toBe(true);
    } finally {
      await composition.storage.close();
    }
  });

  it('surfaces the coordination block in /healthz and the status endpoint', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    const runtime = createProductionRuntime({
      composition,
      logger: (await import('pino')).default({ level: 'silent' }),
    });
    const server = await runtime.start(0, '127.0.0.1');
    const { port } = server.address() as AddressInfo;
    try {
      const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as {
        coordination: { healthy: boolean; activeCoordinations: number; eventCount: number };
      };
      expect(health.coordination.healthy).toBe(true);
      expect(health.coordination.activeCoordinations).toBe(0);
      expect(typeof health.coordination.eventCount).toBe('number');

      const status = (await (
        await fetch(`http://127.0.0.1:${port}/api/coordination/status`)
      ).json()) as {
        healthy: boolean;
        events: { total: number };
      };
      expect(status.healthy).toBe(true);
      expect(typeof status.events.total).toBe('number');
      expect(JSON.stringify(health)).not.toMatch(/postgres|neon|database_url/i);
    } finally {
      await runtime.shutdown();
      await composition.storage.close();
    }
  });
});
