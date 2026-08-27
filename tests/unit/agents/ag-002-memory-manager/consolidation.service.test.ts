import { describe, expect, it } from 'vitest';

import { MemoryConfigSchema } from '../../../../src/agents/ag-002-memory-manager/config/schema.js';
import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import { MemoryValidationError } from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import { MemoryEventType } from '../../../../src/agents/ag-002-memory-manager/events/index.js';
import type { MemoryRecord } from '../../../../src/agents/ag-002-memory-manager/types/index.js';
import { FixedClock } from '../../../../src/agents/ag-002-memory-manager/clock/index.js';
import { InMemoryMemoryEventEmitter } from '../../../../src/agents/ag-002-memory-manager/events/index.js';
import { InMemoryStorageAdapter } from '../../../../src/agents/ag-002-memory-manager/storage/in-memory.js';
import { InMemoryMemoryRepository } from '../../../../src/agents/ag-002-memory-manager/repositories/in-memory.js';
import { createAuthorizationService } from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import type { AuthorizationService } from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import { createMemoryConsolidationService } from '../../../../src/agents/ag-002-memory-manager/services/consolidation.service.js';
import type {
  MemoryConsolidationPolicy,
  MemoryConsolidationService,
} from '../../../../src/agents/ag-002-memory-manager/services/consolidation.service.js';
import { makeActor, makeRecord } from './fixtures.js';

const defaultPolicy: MemoryConsolidationPolicy = {
  enabled: true,
  minRecords: 2,
  maxRecordsPerOperation: 20,
  allowedTypes: [
    MemoryType.Conversation,
    MemoryType.Project,
    MemoryType.Workspace,
    MemoryType.Organization,
    MemoryType.User,
    MemoryType.KnowledgeReference,
    MemoryType.LongTerm,
  ],
  archiveSources: false,
};

interface Env {
  service: MemoryConsolidationService;
  repository: InMemoryMemoryRepository;
  events: InMemoryMemoryEventEmitter;
  clock: FixedClock;
}

function makeEnv(
  configOverrides: Record<string, unknown> = {},
  authService?: AuthorizationService,
): Env {
  const storage = new InMemoryStorageAdapter();
  const repository = new InMemoryMemoryRepository(storage);
  const events = new InMemoryMemoryEventEmitter();
  const clock = new FixedClock('2026-01-01T00:00:00.000Z');
  const config = MemoryConfigSchema.parse({
    MEMORY_CONSOLIDATION_ENABLED: 'true',
    MEMORY_CONSOLIDATION_MIN_RECORDS: 2,
    MEMORY_CONSOLIDATION_MAX_RECORDS: 20,
    ...configOverrides,
  });
  const service = createMemoryConsolidationService({
    repository,
    authorizationService: authService ?? createAuthorizationService(),
    config,
    clock,
    events,
  });
  return { service, repository, events, clock };
}

async function seed(
  repository: InMemoryMemoryRepository,
  records: readonly MemoryRecord[],
): Promise<void> {
  for (const record of records) {
    await repository.create(record);
  }
}

const memoryManager = makeActor(MemoryActorGroup.MemoryManager, [
  'user:1',
  'user:2',
  'workspace:1',
  'org:1',
]);
const scopeLimitedActor = makeActor(MemoryActorGroup.MemoryManager, ['user:2']);
const orchestrator = makeActor(MemoryActorGroup.Orchestrator, ['user:1']);

function conversation(key: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return makeRecord({
    namespace: 'user:1',
    type: MemoryType.Conversation,
    key,
    content: { text: key },
    ...overrides,
  });
}

function consolidationSources(result: {
  records?: readonly MemoryRecord[];
}): { id: string; key: string; version: number }[] | undefined {
  const metadata = result.records?.[0]?.metadata as {
    consolidation?: { sources?: { id: string; key: string; version: number }[] };
  };
  return metadata?.consolidation?.sources;
}

describe('MemoryConsolidationService (Sprint 5B)', () => {
  describe('A. basic consolidation', () => {
    it('consolidates eligible records into one LONG_TERM record', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b'), conversation('c')]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'deduplicate related records',
      });
      expect(result.enabled).toBe(true);
      expect(result.records.length).toBe(1);
      expect(result.records[0]!.type).toBe(MemoryType.LongTerm);
      expect(result.records[0]!.source?.kind).toBe('summarization');
      expect(result.statistics.groupsFormed).toBe(1);
      expect(result.statistics.groupsConsolidated).toBe(1);
      expect(result.statistics.recordsCreated).toBe(1);
      expect(result.statistics.candidatesDiscovered).toBe(3);
      expect(result.statistics.recordsPreserved).toBe(3);
    });
  });

  describe('B. empty repository', () => {
    it('reports a no-op consolidation for an empty repository', async () => {
      const { service } = makeEnv();
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'scan for candidates',
      });
      expect(result.enabled).toBe(true);
      expect(result.records).toEqual([]);
      expect(result.statistics.recordsCreated).toBe(0);
      expect(result.statistics.groupsFormed).toBe(0);
      expect(result.statistics.groupsConsolidated).toBe(0);
    });
  });

  describe('C. below minimum records', () => {
    it('does not consolidate a group below the minimum threshold', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: { ...defaultPolicy, minRecords: 3 },
        reason: 'below minimum',
      });
      expect(result.records).toEqual([]);
      expect(result.statistics.recordsCreated).toBe(0);
      expect(result.statistics.groupsSkipped).toBe(1);
      expect(result.statistics.groupsConsolidated).toBe(0);
    });
  });

  describe('D. minimum records respected', () => {
    it('consolidates when a group exactly meets the minimum', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'exactly minimum',
      });
      expect(result.statistics.recordsCreated).toBe(1);
      expect(result.records.length).toBe(1);
    });
  });

  describe('E. maximum records capped', () => {
    it('caps the number of sources consolidated per operation', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [
        conversation('a'),
        conversation('b'),
        conversation('c'),
        conversation('d'),
      ]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: { ...defaultPolicy, maxRecordsPerOperation: 2 },
        reason: 'bounded operation',
      });
      expect(result.statistics.recordsCreated).toBe(1);
      const sources = consolidationSources(result);
      expect(Array.isArray(sources)).toBe(true);
      expect(sources?.length).toBe(2);
      expect(result.statistics.candidatesExcludedByLimit).toBe(2);
    });
  });

  describe('F. grouping by type', () => {
    it('forms independent groups per memory type', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [
        conversation('a'),
        conversation('b'),
        makeRecord({ namespace: 'user:1', type: MemoryType.Workspace, key: 'w1' }),
        makeRecord({ namespace: 'user:1', type: MemoryType.Workspace, key: 'w2' }),
      ]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'group by type',
      });
      expect(result.statistics.groupsFormed).toBe(2);
      expect(result.statistics.recordsCreated).toBe(2);
      expect(result.records.length).toBe(2);
    });
  });

  describe('G. feature disabled', () => {
    it('returns a no-op when consolidation is disabled', async () => {
      const env = makeEnv({ MEMORY_CONSOLIDATION_ENABLED: 'false' });
      await seed(env.repository, [conversation('a'), conversation('b')]);
      const result = await env.service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: { ...defaultPolicy, enabled: false },
        reason: 'disabled',
      });
      expect(result.enabled).toBe(false);
      expect(result.records).toEqual([]);
      expect(result.statistics.recordsCreated).toBe(0);
    });
  });

  describe('H. cross-namespace isolation', () => {
    it('never consolidates records across namespaces', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [
        conversation('a'),
        conversation('b'),
        makeRecord({ namespace: 'user:2', type: MemoryType.Conversation, key: 'x' }),
        makeRecord({ namespace: 'user:2', type: MemoryType.Conversation, key: 'y' }),
      ]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'scope limited',
      });
      expect(result.statistics.candidatesDiscovered).toBe(2);
      expect(result.statistics.recordsCreated).toBe(1);
      expect(result.records[0]!.namespace).toBe('user:1');
    });
  });

  describe('I. authorization enforcement', () => {
    it('rejects candidates outside the actor scope', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      const candidates = await service.findCandidates({
        actor: scopeLimitedActor,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'scope check',
      });
      expect(candidates.candidatesDiscovered).toBe(2);
      expect(candidates.candidatesAuthorized).toBe(0);
      expect(candidates.filteredByScope).toBe(2);
      expect(candidates.groups).toEqual([]);
    });
  });

  describe('J. security enforcement', () => {
    it('filters confidential candidates when the actor lacks clearance', async () => {
      const restricted = makeActor(MemoryActorGroup.MemoryManager, ['user:1'], {
        securityClearance: MemorySecurityLevel.Internal,
      });
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      const candidates = await service.findCandidates({
        actor: restricted,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'clearance check',
      });
      expect(candidates.filteredBySecurity).toBe(2);
      expect(candidates.candidatesAuthorized).toBe(0);
      const result = await service.consolidate({
        actor: restricted,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'clearance check',
      });
      expect(result.statistics.recordsCreated).toBe(0);
    });
  });

  describe('K. lifecycle filtering', () => {
    it('excludes archived and deleted records from consolidation', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [
        conversation('a'),
        conversation('b'),
        conversation('arch', { lifecycle: MemoryLifecycleState.Archived }),
        conversation('del', { lifecycle: MemoryLifecycleState.Deleted }),
      ]);
      const candidates = await service.findCandidates({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'lifecycle filter',
      });
      expect(candidates.candidatesDiscovered).toBe(2);
      expect(candidates.filteredByLifecycle).toBe(2);
    });
  });

  describe('L. already-consolidated exclusion', () => {
    it('never re-consolidates summarization artifacts', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [
        conversation('a'),
        conversation('b'),
        makeRecord({
          namespace: 'user:1',
          type: MemoryType.LongTerm,
          key: 'consolidated_existing',
          source: { kind: 'summarization', reference: 'con_x' },
        }),
      ]);
      const candidates = await service.findCandidates({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'skip artifacts',
      });
      expect(candidates.candidatesDiscovered).toBe(2);
    });
  });

  describe('M. priority preservation', () => {
    it('output priority equals the highest source priority', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [
        conversation('a', { priority: MemoryPriority.Low }),
        conversation('b', { priority: MemoryPriority.Critical }),
      ]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'priority',
      });
      expect(result.records[0]!.priority).toBe(MemoryPriority.Critical);
    });
  });

  describe('N. security preservation', () => {
    it('output security level reflects the most sensitive source', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [
        conversation('a', { securityLevel: MemorySecurityLevel.Internal }),
        conversation('b', { securityLevel: MemorySecurityLevel.Confidential }),
      ]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'security',
      });
      expect(result.records[0]!.securityLevel).toBe(MemorySecurityLevel.Confidential);
    });
  });

  describe('O. non-destructive', () => {
    it('leaves source records unchanged by default', async () => {
      const { service, repository } = makeEnv();
      const a = conversation('a');
      const b = conversation('b');
      await seed(repository, [a, b]);
      await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'non-destructive',
      });
      const storedA = await repository.get('user:1', 'a');
      const storedB = await repository.get('user:1', 'b');
      expect(storedA!.lifecycle).toBe(MemoryLifecycleState.Active);
      expect(storedB!.lifecycle).toBe(MemoryLifecycleState.Active);
      expect(storedA!.content).toEqual(a.content);
      expect(storedB!.content).toEqual(b.content);
    });
  });

  describe('P. provenance metadata', () => {
    it('records deterministic provenance of the consolidation', async () => {
      const { service, repository } = makeEnv();
      const a = conversation('a');
      const b = conversation('b');
      await seed(repository, [a, b]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'provenance',
        traceId: 'trace_consolidation_1',
      });
      const sources = consolidationSources(result);
      expect(sources?.map((s) => s.key).sort()).toEqual(['a', 'b']);
      expect(result.records[0]!.traceId).toBe('trace_consolidation_1');
      expect(result.records[0]!.metadata).toHaveProperty('consolidation');
    });
  });

  describe('Q. event emission', () => {
    it('emits a MEMORY_CONSOLIDATED event with safe fields', async () => {
      const { service, repository, events } = makeEnv();
      const a = conversation('a');
      const b = conversation('b');
      await seed(repository, [a, b]);
      await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'events',
      });
      const eventsList = events.list();
      const consolidated = eventsList.find((e) => e.type === MemoryEventType.MemoryConsolidated);
      expect(consolidated).toBeDefined();
      expect(consolidated!.namespace).toBe('user:1');
      expect(consolidated!.sourceIds).toHaveLength(2);
      expect(consolidated!.outputId).toBeDefined();
      expect(consolidated!.consolidationId).toBeDefined();
    });
  });

  describe('R. evaluate is read-only', () => {
    it('evaluates candidates without writing anything', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      const evaluation = await service.evaluate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'evaluate only',
      });
      expect(evaluation.possible).toBe(true);
      expect(evaluation.groupsEligible).toBe(1);
      const count = await repository.count({ namespace: 'user:1' });
      expect(count).toBe(2);
    });
  });

  describe('S. idempotency', () => {
    it('re-running consolidation is a no-op and reports a conflict', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      const first = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'first run',
      });
      expect(first.statistics.recordsCreated).toBe(1);
      const second = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'second run',
      });
      expect(second.statistics.recordsCreated).toBe(0);
      expect(second.statistics.conflicts).toBe(1);
      const count = await repository.count({ namespace: 'user:1' });
      expect(count).toBe(3);
    });
  });

  describe('T. concurrent duplicate', () => {
    it('treats an existing consolidated record as idempotent', async () => {
      const { service, repository } = makeEnv();
      const a = conversation('a');
      const b = conversation('b');
      await seed(repository, [a, b]);
      const first = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'first writer',
      });
      const second = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'concurrent writer',
      });
      expect(second.statistics.conflicts).toBe(1);
      expect(second.statistics.recordsCreated).toBe(0);
      const existing = await repository.get('user:1', first.records[0]!.key);
      expect(existing).toBeDefined();
      expect(existing!.source?.kind).toBe('summarization');
    });
  });

  describe('U. write authorization', () => {
    it('denies consolidation when the actor cannot write LONG_TERM', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      await expect(
        service.consolidate({
          actor: orchestrator,
          namespace: 'user:1',
          policy: defaultPolicy,
          reason: 'write authorization',
        }),
      ).rejects.toThrow();
    });
  });

  describe('V. archive sources (opt-in)', () => {
    it('archives sources only when explicitly allowed and authorized', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: { ...defaultPolicy, archiveSources: true },
        reason: 'archive sources',
      });
      expect(result.statistics.recordsCreated).toBe(1);
      const storedA = await repository.get('user:1', 'a');
      expect(storedA!.lifecycle).toBe(MemoryLifecycleState.Archived);
    });
  });

  describe('W. invalid policy', () => {
    it('rejects an invalid maxRecordsPerOperation below minRecords', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      await expect(
        service.consolidate({
          actor: memoryManager,
          namespace: 'user:1',
          policy: { ...defaultPolicy, maxRecordsPerOperation: 1, minRecords: 2 },
          reason: 'invalid policy',
        }),
      ).rejects.toBeInstanceOf(MemoryValidationError);
    });
  });

  describe('X. explicit grouping key', () => {
    it('uses a metadata consolidation group key to form distinct groups', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [
        conversation('a', { metadata: { consolidationGroup: 'contract' } }),
        conversation('b', { metadata: { consolidationGroup: 'contract' } }),
        conversation('c', { metadata: { consolidationGroup: 'proposal' } }),
        conversation('d', { metadata: { consolidationGroup: 'proposal' } }),
      ]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'grouping key',
      });
      expect(result.statistics.groupsFormed).toBe(2);
      expect(result.statistics.recordsCreated).toBe(2);
    });
  });

  describe('Y. content preservation', () => {
    it('preserves the best (highest priority) source content', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [
        conversation('a', { priority: MemoryPriority.Critical, content: { text: 'best' } }),
        conversation('b', { priority: MemoryPriority.Low, content: { text: 'worst' } }),
      ]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'best content',
      });
      expect(result.records[0]!.content).toEqual({ text: 'best' });
    });
  });

  describe('Z. statistics determinism', () => {
    it('reports stable identifiers and non-negative duration', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'statistics',
      });
      expect(result.statistics.consolidationId).toBeTruthy();
      expect(result.statistics.namespace).toBe('user:1');
      expect(result.statistics.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('AA. findCandidates reporting', () => {
    it('reports candidate counts and eligible groups', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b'), conversation('c')]);
      const candidates = await service.findCandidates({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'find candidates',
      });
      expect(candidates.candidatesDiscovered).toBe(3);
      expect(candidates.candidatesAuthorized).toBe(3);
      expect(candidates.groupsEligible).toBe(1);
      expect(candidates.groups.length).toBe(1);
    });
  });

  describe('AB. trace propagation', () => {
    it('propagates the trace id onto the consolidated record', async () => {
      const { service, repository } = makeEnv();
      await seed(repository, [conversation('a'), conversation('b')]);
      const result = await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'trace',
        traceId: 'trace_abc123',
      });
      expect(result.records[0]!.traceId).toBe('trace_abc123');
    });
  });

  describe('AC. reason required', () => {
    it('rejects consolidate without a reason', async () => {
      const { service } = makeEnv();
      await expect(
        service.consolidate({
          actor: memoryManager,
          namespace: 'user:1',
          policy: defaultPolicy,
          reason: '',
        }),
      ).rejects.toBeInstanceOf(MemoryValidationError);
    });
  });

  describe('AD. immutability', () => {
    it('does not mutate the input records array or records', async () => {
      const { service, repository } = makeEnv();
      const a = conversation('a');
      const b = conversation('b');
      await seed(repository, [a, b]);
      const beforeA = { ...a };
      const beforeB = { ...b };
      await service.consolidate({
        actor: memoryManager,
        namespace: 'user:1',
        policy: defaultPolicy,
        reason: 'immutability',
      });
      expect(a.lifecycle).toBe(beforeA.lifecycle);
      expect(b.lifecycle).toBe(beforeB.lifecycle);
      expect(a.content).toEqual(beforeA.content);
      expect(b.content).toEqual(beforeB.content);
    });
  });

  describe('AR. invalid actor', () => {
    it('rejects a request with an invalid actor context', async () => {
      const { service } = makeEnv();
      await expect(
        service.consolidate({
          actor: { group: 'NOT_A_GROUP' as MemoryActorGroup, namespaces: ['user:1'] },
          namespace: 'user:1',
          policy: defaultPolicy,
          reason: 'invalid actor',
        }),
      ).rejects.toBeInstanceOf(MemoryValidationError);
    });
  });
});
