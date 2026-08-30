import { describe, expect, it, vi } from 'vitest';

import { createMemoryContextProvider } from '../../../../../src/agents/ag-001-master-orchestrator/context/memory/memory-context-provider.js';
import {
  ContextPriority,
  ContextSectionType,
  ContextSourceType,
} from '../../../../../src/agents/ag-001-master-orchestrator/context/types/index.js';
import type { MemoryContextLoadInput } from '../../../../../src/agents/ag-001-master-orchestrator/context/interfaces/providers.js';
import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../../src/agents/ag-002-memory-manager/index.js';
import type {
  ContextIntegrationRequest,
  ContextIntegrationResponse,
} from '../../../../../src/agents/ag-002-memory-manager/index.js';
import type {
  MemoryManagerContract,
  RetrievalRequest,
  RetrievalResponse,
} from '../../../../../src/agents/ag-002-memory-manager/index.js';
import type { MemoryRecord } from '../../../../../src/agents/ag-002-memory-manager/index.js';

class StubContract implements MemoryManagerContract {
  readonly name = 'stub-contract';
  readonly retrieveCalls: RetrievalRequest[] = [];
  readonly buildCalls: ContextIntegrationRequest[] = [];
  denyNamespaces: readonly string[] = [];
  buildError: Error | undefined;
  retrieveError: Error | undefined;
  recordsByNamespace: Readonly<Record<string, readonly { record: MemoryRecord; score: number }[]>> =
    {};

  async retrieveService(input: RetrievalRequest): Promise<RetrievalResponse> {
    this.retrieveCalls.push(input);
    if (this.retrieveError) throw this.retrieveError;
    const allowed = this.isAllowed(input.namespace, input.actor.namespaces ?? []);
    const custom = this.recordsByNamespace[input.namespace];
    const source = custom ?? [
      makeResult(makeRecord(input.namespace, 'k1', MemoryPriority.Medium), 0.9),
    ];
    const results = allowed ? source : [];
    return {
      results,
      statistics: {
        candidateCount: results.length,
        authorizedCount: results.length,
        selectedCount: results.length,
        filteredCount: 0,
        truncatedCount: 0,
      },
      metadata: { traceId: input.traceId ?? 'trace', durationMs: 1, truncated: false },
    };
  }

  async buildContext(input: ContextIntegrationRequest): Promise<ContextIntegrationResponse> {
    this.buildCalls.push(input);
    if (this.buildError) throw this.buildError;
    const sections = input.results.map((r) => ({
      type: r.record.type,
      priority: r.record.priority,
      records: [
        {
          id: r.record.id,
          namespace: r.record.namespace,
          key: r.record.key,
          type: r.record.type,
          priority: r.record.priority,
          securityLevel: r.record.securityLevel,
          snippet: `snippet:${r.record.key}`,
          tokenEstimate: 10,
          version: r.record.version,
        },
      ],
      tokenEstimate: 10,
      truncated: false,
      sourceInformation: { candidateCount: 1, selectedCount: 1 },
    }));
    return {
      sections,
      statistics: {
        inputCount: input.results.length,
        authorizedCount: input.results.length,
        filteredCount: 0,
        duplicateCount: 0,
        selectedCount: input.results.length,
        truncatedCount: 0,
        excludedCount: 0,
        estimatedTokens: input.results.length * 10,
        budget: input.contextBudgetTokens ?? 1000,
        sectionsGenerated: sections.length,
        processingDurationMs: 1,
      },
      metadata: { traceId: input.traceId ?? 'trace', durationMs: 1, truncated: false },
      sanitized: true,
      enabled: true,
    };
  }

  private isAllowed(namespace: string, scope: readonly string[]): boolean {
    if (this.denyNamespaces.includes(namespace)) return false;
    return scope.includes(namespace);
  }

  // ---------------------------------------------------------------- unused
  retrieve = vi.fn();
  createMemory = vi.fn();
  updateMemory = vi.fn();
  deleteMemory = vi.fn();
  archiveMemory = vi.fn();
  getMemory = vi.fn();
  restoreMemory = vi.fn();
  queryMemory = vi.fn();
  consolidate = vi.fn();
  health = () => ({ ok: true, storageAvailable: true, availableCapabilities: [], message: 'ok' });
  capabilities = () => ({ name: 'stub-contract', capabilities: [] });
}

function makeRecord(
  namespace: string,
  key: string,
  priority: MemoryPriority,
  type: MemoryType = MemoryType.ShortTerm,
): MemoryRecord {
  return {
    id: `${namespace}:${key}`,
    namespace,
    key,
    type,
    owner: { kind: MemoryOwnerKind.Project, id: 'p1' },
    content: { text: 'content' },
    metadata: { scope: 'x' },
    priority,
    securityLevel: MemorySecurityLevel.Internal,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    retention: { kind: 'none' },
    version: 1,
    lifecycle: MemoryLifecycleState.Active,
    reason: 'test',
    traceId: 'trace',
  };
}

function makeResult(record: MemoryRecord, score = 0.9) {
  return { record, score };
}

function baseInput(overrides: Partial<MemoryContextLoadInput> = {}): MemoryContextLoadInput {
  return {
    actorGroup: MemoryActorGroup.Orchestrator,
    namespaces: ['ns-user-1'],
    query: 'hello',
    traceId: 'trace-1',
    ...overrides,
  };
}

describe('MemoryContextProviderAdapter runtime wiring (Sprint 11)', () => {
  it('returns an empty list when no namespaces are provided', async () => {
    const contract = new StubContract();
    const provider = createMemoryContextProvider({ contract });
    const items = await provider.load(baseInput({ namespaces: [] }));
    expect(items).toHaveLength(0);
    expect(contract.retrieveCalls).toHaveLength(0);
  });

  it('returns an empty list when no input is provided', async () => {
    const contract = new StubContract();
    const provider = createMemoryContextProvider({ contract });
    const items = await provider.load();
    expect(items).toHaveLength(0);
  });

  it('maps a retrieved record into a deterministic context item', async () => {
    const contract = new StubContract();
    const provider = createMemoryContextProvider({ contract });
    const items = await provider.load(baseInput());

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.source.type).toBe(ContextSourceType.MEMORY);
    expect(item.source.id).toBe('ns-user-1');
    expect(item.section).toBe(ContextSectionType.MEMORY);
    expect(item.content).toBe('snippet:k1');
    expect(item.priority).toBe(ContextPriority.NORMAL);
    expect(item.id).toBe('ns-user-1:k1:1');
    expect(item.metadata).toMatchObject({
      namespace: 'ns-user-1',
      key: 'k1',
      version: 1,
      recordId: 'ns-user-1:k1',
    });
  });

  it('iterates over every requested namespace', async () => {
    const contract = new StubContract();
    const provider = createMemoryContextProvider({ contract });
    await provider.load(baseInput({ namespaces: ['ns-a', 'ns-b', 'ns-c'] }));

    expect(contract.retrieveCalls.map((c) => c.namespace)).toEqual(['ns-a', 'ns-b', 'ns-c']);
  });

  it('maps every memory priority to the AG-001 context priority', async () => {
    const cases: Array<[MemoryPriority, ContextPriority]> = [
      [MemoryPriority.Critical, ContextPriority.CRITICAL],
      [MemoryPriority.High, ContextPriority.HIGH],
      [MemoryPriority.Medium, ContextPriority.NORMAL],
      [MemoryPriority.Low, ContextPriority.LOW],
    ];
    for (const [memory, ag001] of cases) {
      const contract = new StubContract();
      contract.recordsByNamespace = {
        'ns-user-1': [makeResult(makeRecord('ns-user-1', 'k', memory))],
      };
      const provider = createMemoryContextProvider({ contract });
      const items = await provider.load(baseInput({ namespaces: ['ns-user-1'] }));
      expect(items).toHaveLength(1);
      expect(items[0]!.priority).toBe(ag001);
    }
  });

  it('propagates the actor (with namespace scope) to the retrieval contract', async () => {
    const contract = new StubContract();
    const provider = createMemoryContextProvider({ contract });
    await provider.load(baseInput());

    expect(contract.retrieveCalls[0]!.actor.group).toBe(MemoryActorGroup.Orchestrator);
    expect(contract.retrieveCalls[0]!.actor.namespaces).toEqual(['ns-user-1']);
    expect(contract.retrieveCalls[0]!.actor.securityClearance).toBeUndefined();
  });

  it('passes security clearance and query through to the retrieval contract', async () => {
    const contract = new StubContract();
    const provider = createMemoryContextProvider({ contract });
    await provider.load(
      baseInput({
        securityClearance: MemorySecurityLevel.Confidential,
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        projectIds: ['p1', 'p2'],
      }),
    );

    expect(contract.retrieveCalls[0]!.actor.securityClearance).toBe(
      MemorySecurityLevel.Confidential,
    );
    expect(contract.retrieveCalls[0]!.actor.organizationId).toBe('org-1');
    expect(contract.retrieveCalls[0]!.actor.workspaceId).toBe('ws-1');
    expect(contract.retrieveCalls[0]!.actor.projectIds).toEqual(['p1', 'p2']);
    expect(contract.retrieveCalls[0]!.query).toBe('hello');
    expect(contract.retrieveCalls[0]!.traceId).toBe('trace-1');
  });

  it('does not leak records from namespaces outside the actor scope (fail-closed)', async () => {
    const contract = new StubContract();
    contract.denyNamespaces = ['ns-user-1'];
    const provider = createMemoryContextProvider({ contract });
    const items = await provider.load(baseInput({ namespaces: ['ns-user-1'] }));
    expect(items).toHaveLength(0);
  });

  it('propagates a retrieval timeout/error to the caller', async () => {
    const contract = new StubContract();
    contract.retrieveError = new Error('retrieval timeout');
    const provider = createMemoryContextProvider({ contract });
    await expect(provider.load(baseInput())).rejects.toThrow('retrieval timeout');
  });

  it('propagates a context-build cancellation/error to the caller', async () => {
    const contract = new StubContract();
    contract.buildError = new Error('context integration aborted');
    const provider = createMemoryContextProvider({ contract });
    await expect(provider.load(baseInput())).rejects.toThrow('context integration aborted');
  });

  it('returns an empty list when retrieval returns no results', async () => {
    const contract = new StubContract();
    contract.denyNamespaces = ['ns-user-1'];
    const provider = createMemoryContextProvider({ contract });
    const items = await provider.load(baseInput({ namespaces: ['ns-user-1'] }));
    expect(items).toHaveLength(0);
    expect(contract.buildCalls).toHaveLength(1);
    expect(contract.buildCalls[0]!.results).toHaveLength(0);
  });
});
