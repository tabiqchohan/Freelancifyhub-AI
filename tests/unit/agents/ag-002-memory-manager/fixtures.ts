import {
  DefaultMemoryLifecycle,
  InMemoryMemoryEventEmitter,
  InMemoryMemoryRepository,
  InMemoryMemoryRetrievalEngine,
  InMemoryStorageAdapter,
  MatrixMemoryAccessPolicy,
  MemoryActorGroup,
  MemoryConfigSchema,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
  createMemoryManagerService,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import type {
  CreateMemoryInput,
  MemoryActor,
  MemoryConfig,
  MemoryManager,
  MemoryOwner,
  MemoryRecord,
} from '../../../../src/agents/ag-002-memory-manager/index.js';

/** Deterministic test configuration (schema defaults). */
export function createTestConfig(): MemoryConfig {
  return MemoryConfigSchema.parse({});
}

/** Creates an actor with an explicit namespace allow-list (fail-closed). */
export function makeActor(group: MemoryActorGroup, namespaces: readonly string[]): MemoryActor {
  return { group, namespaces };
}

export function makeOwner(kind: MemoryOwnerKind, id = '1'): MemoryOwner {
  return { kind, id };
}

let recordSeq = 0;

/** Deterministic, valid memory record builder. */
export function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  recordSeq += 1;
  const createdAt = overrides.createdAt ?? '2026-01-01T00:00:00.000Z';
  return {
    id: overrides.id ?? `memory_test_${recordSeq}`,
    namespace: overrides.namespace ?? 'user:1',
    key: overrides.key ?? `key_${recordSeq}`,
    type: overrides.type ?? MemoryType.Conversation,
    owner: overrides.owner ?? makeOwner(MemoryOwnerKind.User, '1'),
    content: overrides.content ?? { text: 'hello' },
    metadata: overrides.metadata ?? {},
    priority: overrides.priority ?? MemoryPriority.High,
    securityLevel: overrides.securityLevel ?? MemorySecurityLevel.Confidential,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    expiresAt: overrides.expiresAt,
    ttlMs: overrides.ttlMs,
    retention: overrides.retention ?? { kind: 'rolling_window' },
    version: overrides.version ?? 1,
    lifecycle: overrides.lifecycle ?? MemoryLifecycleState.Active,
    reason: overrides.reason ?? 'test reason',
    traceId: overrides.traceId ?? 'trace_test_1',
    source: overrides.source,
  };
}

/** Valid createMemory input builder. */
export function makeCreateInput(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    actor: clientActor,
    namespace: 'user:1',
    key: 'pref_theme',
    type: MemoryType.User,
    owner: makeOwner(MemoryOwnerKind.User, '1'),
    content: { theme: 'dark' },
    reason: 'record user preference',
    ...overrides,
  };
}

export interface TestEnv {
  service: MemoryManager;
  repository: InMemoryMemoryRepository;
  storage: InMemoryStorageAdapter;
  events: InMemoryMemoryEventEmitter;
  accessPolicy: MatrixMemoryAccessPolicy;
  lifecycle: DefaultMemoryLifecycle;
  retrieval: InMemoryMemoryRetrievalEngine;
}

/** Wires a fully deterministic, in-memory memory manager for tests. */
export function createTestEnv(options: { config?: MemoryConfig } = {}): TestEnv {
  const storage = new InMemoryStorageAdapter();
  const repository = new InMemoryMemoryRepository(storage);
  const accessPolicy = new MatrixMemoryAccessPolicy();
  const lifecycle = new DefaultMemoryLifecycle();
  const retrieval = new InMemoryMemoryRetrievalEngine(repository);
  const events = new InMemoryMemoryEventEmitter();
  const service = createMemoryManagerService({
    repository,
    accessPolicy,
    lifecycle,
    retrievalEngine: retrieval,
    config: options.config ?? createTestConfig(),
    events,
  });
  return { service, repository, storage, events, accessPolicy, lifecycle, retrieval };
}

/** Preset actors with explicit allow-lists (spec §7). */
export const orchestratorActor = makeActor(MemoryActorGroup.Orchestrator, ['system:plans']);
export const memoryManagerActor = makeActor(MemoryActorGroup.MemoryManager, [
  'system:canonical',
  'system:archive',
  'user:1',
  'project:1',
]);
export const clientActor = makeActor(MemoryActorGroup.Client, ['user:1', 'project:1']);
export const freelancerActor = makeActor(MemoryActorGroup.Freelancer, ['user:2', 'project:1']);
export const marketplaceActor = makeActor(MemoryActorGroup.Marketplace, ['project:1']);
export const marketingActor = makeActor(MemoryActorGroup.Marketing, ['workspace:1']);
export const adminActor = makeActor(MemoryActorGroup.Admin, [
  'org:1',
  'workspace:admin:1',
  'system:canonical',
]);
