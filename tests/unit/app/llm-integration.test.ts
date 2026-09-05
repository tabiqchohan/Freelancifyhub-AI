import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import { parseCompiledEnv } from '../../../src/app/env.js';
import { LLMConfigurationError } from '../../../src/llm/errors/index.js';

function inMemoryEnv(overrides: Record<string, string> = {}): ReturnType<typeof parseCompiledEnv> {
  const env = parseCompiledEnv(overrides);
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  return env;
}

describe('createProductionComposition - LLM (Sprint 17)', () => {
  it('boots with LLM disabled and exposes a fail-closed reasoning service', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    try {
      expect(composition.services.aiReasoning.isEnabled()).toBe(false);
      expect(composition.services.aiReasoning.providerInfo()).toEqual({
        enabled: false,
        configured: false,
        provider: 'disabled',
        model: '',
      });
      expect(composition.services.llmEventLog).toBeDefined();
      await expect(
        composition.services.aiReasoning.reason({ userInput: 'x' }),
      ).rejects.toMatchObject({ code: 'REASONING_UNAVAILABLE' });
    } finally {
      await composition.storage.close();
    }
  });

  it('boots with the deterministic mock provider when LLM is enabled', async () => {
    const composition = await createProductionComposition({
      env: inMemoryEnv({ LLM_ENABLED: 'true', LLM_PROVIDER: 'mock' }),
    });
    try {
      expect(composition.services.aiReasoning.isEnabled()).toBe(true);
      expect(composition.services.aiReasoning.providerInfo().provider).toBe('mock');
      expect(composition.services.aiReasoning.providerInfo().model).toBe('mock-model-1.0');
    } finally {
      await composition.storage.close();
    }
  });

  it('fails closed when http is enabled without an API key', async () => {
    expect(() => inMemoryEnv({ LLM_ENABLED: 'true', LLM_PROVIDER: 'http' })).toThrow(
      LLMConfigurationError,
    );
  });

  it('boots with a disabled http provider without requiring credentials', async () => {
    const composition = await createProductionComposition({
      env: inMemoryEnv({ LLM_ENABLED: 'false', LLM_PROVIDER: 'http' }),
    });
    try {
      expect(composition.services.aiReasoning.isEnabled()).toBe(false);
    } finally {
      await composition.storage.close();
    }
  });
});

describe('ProductionRuntime - LLM (Sprint 17)', () => {
  async function startRuntime(env: ReturnType<typeof parseCompiledEnv>) {
    const composition = await createProductionComposition({ env });
    const runtime = createProductionRuntime({
      composition,
      logger: (await import('pino')).default({ level: 'silent' }),
    });
    const server = await runtime.start(0, '127.0.0.1');
    const { port } = server.address() as AddressInfo;
    return { runtime, composition, baseUrl: `http://127.0.0.1:${port}` };
  }

  it('reports disabled LLM status in /healthz and /api/llm/status', async () => {
    const { runtime, baseUrl } = await startRuntime(inMemoryEnv());
    try {
      const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
        llm: { enabled: boolean; provider: string };
      };
      expect(health.llm.enabled).toBe(false);
      expect(health.llm.provider).toBe('disabled');

      const status = (await (await fetch(`${baseUrl}/api/llm/status`)).json()) as {
        enabled: boolean;
        provider: string;
        events: { total: number };
        metrics: { totals: { requests: number } };
      };
      expect(status.enabled).toBe(false);
      expect(status.provider).toBe('disabled');
      expect(status.events.total).toBe(0);
      expect(status.metrics.totals.requests).toBe(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it('reports mock provider status when LLM is enabled', async () => {
    const { runtime, baseUrl } = await startRuntime(
      inMemoryEnv({ LLM_ENABLED: 'true', LLM_PROVIDER: 'mock' }),
    );
    try {
      const status = (await (await fetch(`${baseUrl}/api/llm/status`)).json()) as {
        enabled: boolean;
        provider: string;
      };
      expect(status.enabled).toBe(true);
      expect(status.provider).toBe('mock');
    } finally {
      await runtime.shutdown();
    }
  });
});
