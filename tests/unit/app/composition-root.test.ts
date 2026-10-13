import { describe, expect, it } from 'vitest';

import {
  createProductionComposition,
  resolveKnowledgeDatabaseUrl,
} from '../../../src/app/composition-root.js';
import { DiagnosticError } from '../../../src/app/errors.js';
import { parseCompiledEnv } from '../../../src/app/env.js';
import { AgentStatus } from '../../../src/agents/ag-001-master-orchestrator/types/index.js';

describe('createProductionComposition (Phase 1)', () => {
  // Use an explicit in-memory env so tests are hermetic and independent of any
  // durable `.env`/process environment present on the machine.
  const inMemoryEnv = (): ReturnType<typeof parseCompiledEnv> => {
    const env = parseCompiledEnv({});
    env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
    return env;
  };

  it('assembles the full runtime dependency graph with the default in-memory backend', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    expect(composition.services.agentRegistry.size).toBeGreaterThanOrEqual(1);
    expect(composition.services.agentRegistry.isAvailable('AG-101')).toBe(true);
    expect(composition.services.memoryManager.capabilities().capabilities).toContain('retrieve');
    expect(composition.services.executor).toBeDefined();
    expect(composition.services.orchestrator).toBeDefined();
    expect(composition.storage.durable).toBe(false);
    await composition.storage.close();
  });

  it('registers the runtime agent under the AG-101 production slot', async () => {
    const composition = await createProductionComposition({ env: inMemoryEnv() });
    const config = composition.services.agentRegistry.configurationOf('AG-101');
    expect(config?.agentId).toBe('AG-101');
    expect(config?.name).toBe('Project Description Agent');
    expect(config?.status).toBe(AgentStatus.InDevelopment);
    await composition.storage.close();
  });

  it('fails closed on an unsupported storage backend', async () => {
    const env = parseCompiledEnv({});
    env.memory.MEMORY_STORAGE_BACKEND = 'unsupported';
    await expect(createProductionComposition({ env })).rejects.toBeInstanceOf(DiagnosticError);
  });

  it('fails closed when the durable backend is selected without a database url', async () => {
    const env = parseCompiledEnv({});
    env.memory.MEMORY_STORAGE_BACKEND = 'durable';
    env.memory.MEMORY_DATABASE_URL = undefined;
    await expect(createProductionComposition({ env })).rejects.toBeInstanceOf(DiagnosticError);
  });

  it('fails closed when durable knowledge is selected without any database url', async () => {
    const env = parseCompiledEnv({});
    env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
    env.memory.MEMORY_DATABASE_URL = undefined;
    env.knowledge.KNOWLEDGE_STORAGE_BACKEND = 'durable';
    env.knowledge.KNOWLEDGE_DATABASE_URL = undefined;
    await expect(createProductionComposition({ env })).rejects.toBeInstanceOf(DiagnosticError);
  });
});

describe('resolveKnowledgeDatabaseUrl (durable knowledge URL reuse)', () => {
  const envWith = (knowledgeUrl?: string, memoryUrl?: string) => {
    const env = parseCompiledEnv({});
    env.knowledge.KNOWLEDGE_DATABASE_URL = knowledgeUrl;
    env.memory.MEMORY_DATABASE_URL = memoryUrl;
    return env;
  };

  it('prefers a dedicated knowledge database url', () => {
    expect(resolveKnowledgeDatabaseUrl(envWith('postgresql://k/db', 'postgresql://m/db'))).toBe(
      'postgresql://k/db',
    );
  });

  it('falls back to the shared memory database url when no dedicated url is set', () => {
    expect(resolveKnowledgeDatabaseUrl(envWith(undefined, 'postgresql://m/db'))).toBe(
      'postgresql://m/db',
    );
    expect(resolveKnowledgeDatabaseUrl(envWith('', 'postgresql://m/db'))).toBe('postgresql://m/db');
    expect(resolveKnowledgeDatabaseUrl(envWith('   ', 'postgresql://m/db'))).toBe(
      'postgresql://m/db',
    );
  });

  it('returns undefined when neither url is set so the caller fails closed', () => {
    expect(resolveKnowledgeDatabaseUrl(envWith(undefined, undefined))).toBeUndefined();
    expect(resolveKnowledgeDatabaseUrl(envWith('', ''))).toBeUndefined();
  });
});
