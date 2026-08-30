import { describe, expect, it } from 'vitest';

import {
  createOrchestrationMemoryService,
  InMemoryOrchestrationMetrics,
  MemoryContextStatus,
  MemoryWriteBackPolicy,
} from '../../../../src/agents/ag-002-memory-manager/orchestration/index.js';
import {
  StubMemoryManagerContract,
  StubMetricSink,
} from '../../../../src/agents/ag-002-memory-manager/orchestration/test-doubles.js';
import {
  InMemoryMemoryEventEmitter,
  MemoryEventType,
} from '../../../../src/agents/ag-002-memory-manager/events/index.js';
import {
  MemoryActorGroup,
  MemoryOwnerKind,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import { MemoryConfigSchema } from '../../../../src/agents/ag-002-memory-manager/config/schema.js';
import { makeActor, makeRecord, makeOwner } from './fixtures.js';
import type {
  OrchestrationMemoryRequest,
  MemoryContextResult,
} from '../../../../src/agents/ag-002-memory-manager/orchestration/index.js';

const enabledConfig = MemoryConfigSchema.parse({
  MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED: 'true',
});

const disabledConfig = MemoryConfigSchema.parse({
  MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED: 'false',
});

const actor = makeActor(MemoryActorGroup.MemoryManager, ['user:1', 'project:1']);

function makeRequest(
  overrides: Partial<OrchestrationMemoryRequest> = {},
): OrchestrationMemoryRequest {
  return {
    actor,
    namespace: 'user:1',
    requestId: 'req-1',
    executionId: 'exec-1',
    correlationId: 'corr-1',
    query: 'preference',
    ...overrides,
  };
}

describe('Sprint 8 - OrchestrationMemoryService: feature gate + fail-closed', () => {
  it('returns Disabled when the integration flag is off', async () => {
    const contract = new StubMemoryManagerContract();
    const service = createOrchestrationMemoryService({
      contract,
      config: disabledConfig,
      metrics: new InMemoryOrchestrationMetrics(),
    });
    const result = await service.fetchMemoryContext(makeRequest());
    expect(result.enabled).toBe(false);
    expect(result.status).toBe(MemoryContextStatus.Disabled);
    expect(result.sections).toHaveLength(0);
    expect(result.warnings).toContain('memory integration disabled');
  });

  it('returns SecurityDenied for a malformed actor (missing namespaces)', async () => {
    const contract = new StubMemoryManagerContract();
    const metrics = new StubMetricSink();
    const service = createOrchestrationMemoryService({
      contract,
      config: enabledConfig,
      metrics,
    });
    const request = makeRequest();
    const badActor = { ...actor, namespaces: [] as readonly string[] };
    const result = await service.fetchMemoryContext({ ...request, actor: badActor });
    expect(result.status).toBe(MemoryContextStatus.SecurityDenied);
    expect(metrics.denials).toBeGreaterThan(0);
  });

  it('returns Unavailable when the contract reports unhealthy', async () => {
    const contract = new StubMemoryManagerContract();
    contract.healthy = false;
    const service = createOrchestrationMemoryService({
      contract,
      config: enabledConfig,
      metrics: new InMemoryOrchestrationMetrics(),
    });
    const result = await service.fetchMemoryContext(makeRequest());
    expect(result.status).toBe(MemoryContextStatus.Unavailable);
    expect(result.warnings).toContain('memory integration unavailable');
  });
});

describe('Sprint 8 - OrchestrationMemoryService: happy path + redaction', () => {
  it('returns Available context with sections when retrieval matches', async () => {
    const contract = new StubMemoryManagerContract();
    contract.retrievalResults = [
      {
        record: makeRecord({
          id: 'mem-1',
          namespace: 'user:1',
          key: 'theme_pref',
          type: MemoryType.User,
          owner: makeOwner(MemoryOwnerKind.User, '1'),
        }),
        score: 0.9,
        snippet: 'theme dark',
      },
    ];
    contract.contextSections = [
      {
        type: MemoryType.User,
        priority: MemoryPriority.High,
        records: [
          {
            id: 'mem-1',
            namespace: 'user:1',
            key: 'theme_pref',
            type: MemoryType.User,
            priority: MemoryPriority.High,
            securityLevel: MemorySecurityLevel.Confidential,
            snippet: 'theme dark',
            tokenEstimate: 4,
            version: 1,
          },
        ],
        tokenEstimate: 4,
        truncated: false,
        sourceInformation: { candidateCount: 1, selectedCount: 1 },
      },
    ];
    const metrics = new InMemoryOrchestrationMetrics();
    const events = new InMemoryMemoryEventEmitter();
    let capturedType: string | undefined;
    const captured: string[] = [];
    events.on((e) => {
      capturedType = e.type;
      captured.push(e.type);
    });
    const service = createOrchestrationMemoryService({
      contract,
      events,
      config: enabledConfig,
      metrics,
    });

    const result = await service.fetchMemoryContext(makeRequest());
    expect(result.enabled).toBe(true);
    expect(result.status).toBe(MemoryContextStatus.Available);
    expect(result.sections).toHaveLength(1);
    expect(result.recordCount).toBe(1);
    expect(result.sections[0]?.records[0]?.snippet).toBe('theme dark');
    expect(capturedType).toBe(MemoryEventType.Retrieved);
    const snap = metrics.snapshot();
    expect(snap.retrievalCount).toBe(1);
    expect(snap.retrievalSuccess).toBe(1);
  });

  it('treats an empty retrieval as Empty status', async () => {
    const contract = new StubMemoryManagerContract();
    const metrics = new StubMetricSink();
    const service = createOrchestrationMemoryService({
      contract,
      config: enabledConfig,
      metrics,
    });
    const result = await service.fetchMemoryContext(makeRequest());
    expect(result.status).toBe(MemoryContextStatus.Empty);
    expect(result.recordCount).toBe(0);
    expect(metrics.statuses).toContain(MemoryContextStatus.Empty);
  });

  it('exposes truthful health and capabilities', () => {
    const contract = new StubMemoryManagerContract();
    const service = createOrchestrationMemoryService({
      contract,
      config: enabledConfig,
      metrics: new InMemoryOrchestrationMetrics(),
    });
    const health = service.health();
    expect(health.integration.enabled).toBe(true);
    expect(health.integration.available).toBe(true);
    expect(health.integration.retrievalAvailable).toBe(true);

    const caps = service.capabilities();
    expect(caps.enabled).toBe(true);
    expect(caps.writeBack).toBe(MemoryWriteBackPolicy.None);
  });

  it('preserves AG-001 correlation identifiers verbatim', async () => {
    const contract = new StubMemoryManagerContract();
    const service = createOrchestrationMemoryService({
      contract,
      config: enabledConfig,
      metrics: new InMemoryOrchestrationMetrics(),
    });
    const result: MemoryContextResult = await service.fetchMemoryContext(
      makeRequest({
        requestId: 'corr-preserve-req',
        executionId: 'corr-preserve-exec',
        correlationId: 'corr-preserve-id',
      }),
    );
    expect(result.requestId).toBe('corr-preserve-req');
    expect(result.executionId).toBe('corr-preserve-exec');
    expect(result.correlationId).toBe('corr-preserve-id');
  });

  it('fails closed on a cancelled request without touching retrieval', async () => {
    const contract = new StubMemoryManagerContract();
    let invoked = false;
    contract.retrieveService = (async () => {
      invoked = true;
      throw new Error('should not be reached');
    }) as never;
    const service = createOrchestrationMemoryService({
      contract,
      config: enabledConfig,
      metrics: new InMemoryOrchestrationMetrics(),
    });
    const result = await service.fetchMemoryContext(makeRequest({ isCancelled: () => true }));
    expect(result.status).toBe(MemoryContextStatus.Unavailable);
    expect(invoked).toBe(false);
  });
});

describe('Sprint 8 - OrchestrationMemoryService: timeout handling', () => {
  it('maps a retrieval timeout to Timeout status', async () => {
    const contract = new StubMemoryManagerContract();
    contract.retrieveService = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      throw new Error('never');
    }) as never;
    const config = MemoryConfigSchema.parse({
      MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED: 'true',
      MEMORY_ORCHESTRATOR_RETRIEVAL_TIMEOUT_MS: 5,
    });
    const service = createOrchestrationMemoryService({
      contract,
      config,
      metrics: new InMemoryOrchestrationMetrics(),
    });
    const result = await service.fetchMemoryContext(makeRequest());
    expect(result.status).toBe(MemoryContextStatus.Timeout);
    expect(result.warnings.join(' ')).toMatch(/timed out|timeout/i);
  });

  it('maps an authorization denial during retrieval to SecurityDenied', async () => {
    const contract = new StubMemoryManagerContract();
    contract.retrieveService = (async () => {
      throw new Error('access denied: caller scope outside allow-list');
    }) as never;
    const metrics = new StubMetricSink();
    const service = createOrchestrationMemoryService({
      contract,
      config: enabledConfig,
      metrics,
    });
    const result = await service.fetchMemoryContext(makeRequest());
    expect(result.status).toBe(MemoryContextStatus.SecurityDenied);
    expect(metrics.denials).toBeGreaterThan(0);
  });
});

const actionPerformer = (withOwnerKinds: readonly string[] = []) => ({
  name: 'integration-allow-all',
  authorize(input: {
    actor: { group: unknown; namespaces?: readonly string[]; id?: string };
    permission: unknown;
    target: { namespace?: string; owner?: { kind?: string } };
  }) {
    const scoped =
      input.target.namespace !== undefined
        ? (input.actor.namespaces ?? []).includes(input.target.namespace)
        : true;
    const ownerOk =
      withOwnerKinds.length === 0 ||
      (input.target.owner !== undefined &&
        withOwnerKinds.includes(String(input.target.owner.kind)));
    if (!scoped || !ownerOk) {
      return { allowed: false, reason: 'out of scope', code: 'OUT_OF_SCOPE' };
    }
    return { allowed: true };
  },
});

const scopedAuth = actionPerformer();

describe('Sprint 8 - real AG-002 integration', () => {
  it('runs the real retrieval pipeline and returns bounded context', async () => {
    const { InMemoryStorageAdapter } =
      await import('../../../../src/agents/ag-002-memory-manager/storage/in-memory.js');
    const { InMemoryMemoryRepository } =
      await import('../../../../src/agents/ag-002-memory-manager/repositories/in-memory.js');
    const { createRetrievalService } =
      await import('../../../../src/agents/ag-002-memory-manager/services/retrieval.service.js');
    const { createContextIntegrationService } =
      await import('../../../../src/agents/ag-002-memory-manager/services/context-integration.service.js');
    const { createMemoryConsolidationService } =
      await import('../../../../src/agents/ag-002-memory-manager/services/consolidation.service.js');
    const { createMemoryManagerService } =
      await import('../../../../src/agents/ag-002-memory-manager/services/memory.service.js');
    const { MemoryManagerContractAdapter } =
      await import('../../../../src/agents/ag-002-memory-manager/orchestration/memory-manager.js');
    const { InMemoryMemoryRetrievalEngine } =
      await import('../../../../src/agents/ag-002-memory-manager/retrieval/in-memory.js');
    const { DefaultMemoryLifecycle } =
      await import('../../../../src/agents/ag-002-memory-manager/lifecycle/index.js');
    const { MatrixMemoryAccessPolicy } =
      await import('../../../../src/agents/ag-002-memory-manager/security/index.js');
    const { MemoryOwnerKind } =
      await import('../../../../src/agents/ag-002-memory-manager/enums/index.js');

    const storage = new InMemoryStorageAdapter();
    const repository = new InMemoryMemoryRepository(storage);
    const events = new InMemoryMemoryEventEmitter();
    const accessPolicy = new MatrixMemoryAccessPolicy();
    const lifecycle = new DefaultMemoryLifecycle();
    const retrievalEngine = new InMemoryMemoryRetrievalEngine(repository);
    const config = enabledConfig;

    const manager = createMemoryManagerService({
      repository,
      accessPolicy,
      lifecycle,
      retrievalEngine,
      config,
      events,
    });

    await manager.createMemory({
      actor,
      namespace: 'user:1',
      key: 'theme_pref',
      type: MemoryType.User,
      owner: { kind: MemoryOwnerKind.User, id: '1' },
      content: { theme: 'dark' },
      reason: 'integration seed',
    });

    const retrieval = createRetrievalService({
      repository,
      authorizationService: scopedAuth,
      config,
      clock: undefined,
      logger: undefined,
    });
    const contextIntegration = createContextIntegrationService({
      authorizationService: scopedAuth,
      config,
    });
    const consolidation = createMemoryConsolidationService({
      repository,
      authorizationService: scopedAuth,
      config,
      clock: undefined,
      events,
    });

    const contract = new MemoryManagerContractAdapter({
      manager,
      retrieval,
      contextIntegration,
      consolidation,
      storageAvailable: true,
    });

    const service = createOrchestrationMemoryService({
      contract,
      events,
      config,
      metrics: new InMemoryOrchestrationMetrics(),
    });

    const result = await service.fetchMemoryContext(makeRequest({ query: 'theme' }));
    expect(result.enabled).toBe(true);
    expect(result.status).toBe(MemoryContextStatus.Available);
    expect(result.recordCount).toBe(1);
    const entries = result.sections.flatMap((s) => s.records);
    expect(entries.length).toBe(1);
  });
});
