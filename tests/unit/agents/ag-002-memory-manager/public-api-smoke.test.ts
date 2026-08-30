import { describe, expect, it } from 'vitest';

import { MemoryContextProviderAdapter } from '../../../../src/agents/ag-001-master-orchestrator/context/memory/memory-context-provider.js';
import { createMemoryContextProvider } from '../../../../src/agents/ag-001-master-orchestrator/context/memory/memory-context-provider.js';

import {
  RetrievalServiceImpl,
  createRetrievalService,
  MemoryConfigSchema,
} from '../../../../src/agents/ag-002-memory-manager/index.js';

/**
 * Sprint 11 public-API smoke tests (Final Gap Audit #2/#3/#4/#6).
 * Verifies the public barrels are reachable and no longer leak internal
 * (test-double / dead barrel / dead-flag) contracts.
 */
describe('AG-002 public API surface (Sprint 11 hygiene)', () => {
  it('exposes RetrievalServiceImpl and createRetrievalService from the public barrel (#3)', () => {
    expect(typeof RetrievalServiceImpl).toBe('function');
    expect(typeof createRetrievalService).toBe('function');
  });

  it('AG-001 exposes the memory context provider adapter and factory', () => {
    expect(typeof MemoryContextProviderAdapter).toBe('function');
    expect(typeof createMemoryContextProvider).toBe('function');
  });

  it('produces a createMemoryContextProvider that implements the provider source', () => {
    const provider = createMemoryContextProvider({
      contract: {
        name: 'stub',
        retrieveService: async () => ({ results: [], statistics: {} }) as never,
        buildContext: async () => ({ sections: [] }) as never,
        retrieve: async () => [],
        createMemory: async () => ({}) as never,
        updateMemory: async () => ({}) as never,
        deleteMemory: async () => ({}) as never,
        archiveMemory: async () => ({}) as never,
        getMemory: async () => ({}) as never,
        restoreMemory: async () => ({}) as never,
        queryMemory: async () => [],
        consolidate: async () => ({}) as never,
        health: () => ({ ok: true }) as never,
        capabilities: () => ({ name: 'stub', capabilities: [] }),
      } as never,
    });
    expect(provider.source).toBe('memory');
  });

  it('removes the dead hybrid-search and incremental-summary flags from the schema (#6)', () => {
    const parsed = MemoryConfigSchema.parse({});
    expect('MEMORY_HYBRID_SEARCH_ENABLED' in parsed).toBe(false);
    expect('MEMORY_INCREMENTAL_SUMMARY_ENABLED' in parsed).toBe(false);
  });

  it('keeps the live right-to-forget and event-log-replay gates (#6)', () => {
    const parsed = MemoryConfigSchema.parse({});
    expect('MEMORY_RIGHT_TO_FORGET_ENABLED' in parsed).toBe(true);
    expect('MEMORY_EVENT_LOG_REPLAY_ENABLED' in parsed).toBe(true);
  });
});
