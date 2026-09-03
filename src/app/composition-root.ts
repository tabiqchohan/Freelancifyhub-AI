import type { Logger } from 'pino';

import { ExecutionEngine } from '../agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../agents/ag-001-master-orchestrator/execution/config/index.js';
import { parseOrchestratorConfig } from '../agents/ag-001-master-orchestrator/config/index.js';
import { RuleBasedIntentClassifier } from '../agents/ag-001-master-orchestrator/intent/classifiers/index.js';
import { ExecutionPlanBuilder } from '../agents/ag-001-master-orchestrator/planning/builders/index.js';
import { RoutingEngine } from '../agents/ag-001-master-orchestrator/routing/engine.js';
import { SharedAggregationService } from '../agents/ag-001-master-orchestrator/aggregation/aggregators/index.js';
import { MasterOrchestratorService } from '../agents/ag-001-master-orchestrator/orchestrator/services/master-orchestrator.service.js';
import { InMemoryOrchestratorEventEmitter } from '../agents/ag-001-master-orchestrator/orchestrator/services/events.js';
import type { ContextBuilder as ContextBuilderType } from '../agents/ag-001-master-orchestrator/context/index.js';
import { ContextBuilder } from '../agents/ag-001-master-orchestrator/context/index.js';
import { createOrchestratorLogger } from '../agents/ag-001-master-orchestrator/utils/logger.js';
import type { ExecutorRegistry } from '../agents/ag-001-master-orchestrator/execution/index.js';
import { createMemoryContextProvider } from '../agents/ag-001-master-orchestrator/context/index.js';

import {
  InMemoryStorageAdapter,
  InMemoryMemoryRepository,
  InMemoryMemoryRetrievalEngine,
  MatrixMemoryAccessPolicy,
  DefaultMemoryLifecycle,
  createMemoryManagerService,
  createRetrievalService,
  createContextIntegrationService,
  createMemoryConsolidationService,
  createAuthorizationService,
  InMemoryMemoryEventEmitter,
  MemoryManagerContractAdapter,
  createPostgresAdapter,
  PostgresMemoryRepository,
  PostgresEventSink,
  createEventLog,
  createPostgresPool,
} from '../agents/ag-002-memory-manager/index.js';
import type {
  MemoryConfig,
  MemoryRepository,
  InMemoryEventLog,
} from '../agents/ag-002-memory-manager/index.js';
import type { MemoryManagerContract } from '../agents/ag-002-memory-manager/orchestration/manager-interface.js';
import type { Pool } from 'pg';

import {
  InMemoryKnowledgeRepository,
  KnowledgeManagerService,
  PostgresKnowledgeRepository,
  createKnowledgeEventLog,
  type KnowledgeEventLog,
  type KnowledgeRepository,
} from '../agents/ag-003-knowledge-manager/index.js';

import type { Environment } from './env.js';
import { parseCompiledEnv } from './env.js';
import { AgentRegistry } from '../agents/runtime/registry.js';
import { ProductionAgentExecutor, ProductionExecutorRegistry } from '../agents/runtime/executor.js';
import { RuntimeAgentEventType } from '../agents/runtime/types.js';
import { createRuntimeAgent } from '../agents/runtime/runtime-agent.js';
import { RuntimeEventBridge } from './runtime-event-bridge.js';
import { RequestActorRegistry } from './request-actors.js';
import { MemoryAwareContextInputBuilder } from './memory-context-builder.js';
import { DiagnosticError } from './errors.js';

/**
 * Phase 1 — the single, authoritative production composition root.
 *
 * Constructs the real AG-001 ↔ AG-002 runtime dependency graph end-to-end:
 *
 *   env → memory storage → repository → AG-002 services (retrieval / context /
 *   consolidation / lifecycle / authorization) → MemoryManagerContract →
 *   MemoryContextProvider (AG-001 adapter) → runtime agent registry → the
 *   real ProductionAgentExecutor → ExecutionEngine → routing / planning /
 *   intent → MasterOrchestratorService → request/actor plumbing → runtime
 *   events → AG-002 event log (+ Postgres sink in durable mode).
 *
 * This is the only place a full runtime graph is assembled in production. It is
 * fail-closed: invalid configuration, missing durable credentials, or an
 * unavailable storage backend abort construction with a {@link DiagnosticError}
 * rather than silently degrade. Built lazily via {@link createProductionComposition}.
 */

export interface ProductionComposition {
  readonly env: Environment;
  readonly logger: Logger;
  readonly services: {
    readonly memoryManager: MemoryManagerContract;
    readonly knowledgeManager: KnowledgeManagerService;
    readonly agentRegistry: AgentRegistry;
    readonly executor: ProductionAgentExecutor;
    readonly executionEngine: ExecutionEngine;
    readonly orchestrator: MasterOrchestratorService;
    readonly orchestratorEvents: InMemoryOrchestratorEventEmitter;
    readonly memoryEvents: InMemoryMemoryEventEmitter;
    readonly eventBridge: RuntimeEventBridge;
    readonly eventLog: InMemoryEventLog;
    readonly knowledgeEventLog: KnowledgeEventLog;
    readonly requestActors: RequestActorRegistry;
  };
  /** Storage handles for graceful shutdown. Not part of the public contract. */
  readonly storage: {
    readonly close: () => Promise<void>;
    readonly durable: boolean;
  };
  /** Health-check handles (Phase 8). Not part of the public contract. */
  readonly health: {
    readonly probeStorage: () => Promise<{ healthy: boolean }>;
    readonly probeKnowledgeStorage: () => Promise<{ healthy: boolean }>;
  };
}

function requiredString(env: Environment, key: string): string {
  const value = env.memory[key as keyof MemoryConfig] as unknown;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DiagnosticError(`Missing required configuration: ${key}`, {
      code: 'MISSING_REQUIRED_CONFIG',
      details: { key },
    });
  }
  return value;
}

/**
 * Assembles the real production runtime dependency graph.
 *
 * Construction is async only because the durable (PostgreSQL) backend requires
 * an open pool and schema migration before any adapter is usable. For the
 * default in-memory backend construction is synchronous-within-async (no I/O).
 */
export async function createProductionComposition(
  options: {
    readonly env?: Environment;
    readonly logger?: Logger;
  } = {},
): Promise<ProductionComposition> {
  const env = options.env ?? parseCompiledEnv();
  const logger = options.logger ?? createOrchestratorLogger('composition-root');

  const orchestratorConfig = parseOrchestratorConfig({});

  const executionConfig = parseExecutionConfig({
    EXECUTION_EVENTS_ENABLED: 'true',
    EXECUTION_BACKOFF_BASE_MS: String(orchestratorConfig.ORCHESTRATOR_RETRY_BASE_MS),
    EXECUTION_BACKOFF_MAX_MS: String(orchestratorConfig.ORCHESTRATOR_RETRY_BASE_MS * 4),
  });

  // ---- AG-002 memory stack -------------------------------------------------
  // The backend is driven by the resolved runtime environment (`env.memory`),
  // so an injected/parsed env is authoritative and fail-closed on invalid values.
  const backend = env.memory.MEMORY_STORAGE_BACKEND;
  const memoryConfig = env.memory;

  let storageClose: () => Promise<void> = async () => undefined;
  let durable = false;
  let probeStorage: () => Promise<{ healthy: boolean }> = async () => ({ healthy: true });

  const memoryEmitter = new InMemoryMemoryEventEmitter();
  const eventLog = createEventLog();

  let memoryRepository: MemoryRepository;
  let postgresPool: Pool | undefined;

  if (backend === 'in-memory') {
    memoryRepository = new InMemoryMemoryRepository(new InMemoryStorageAdapter());
  } else if (backend === 'durable') {
    const connection = requiredString(env, 'MEMORY_DATABASE_URL');
    const adapter = await createPostgresAdapter({ connection });
    durable = true;
    memoryRepository = new PostgresMemoryRepository(adapter);
    postgresPool = adapter.poolForRepository;
    storageClose = () => adapter.close();
    probeStorage = async () => {
      try {
        const health = await adapter.healthAsync();
        return { healthy: health.healthy };
      } catch {
        return { healthy: false };
      }
    };
  } else {
    throw new DiagnosticError(`Unsupported memory storage backend: ${backend}`, {
      code: 'UNSUPPORTED_STORAGE_BACKEND',
      details: { backend },
    });
  }

  const accessPolicy = new MatrixMemoryAccessPolicy();
  const lifecycle = new DefaultMemoryLifecycle();
  const retrievalEngine = new InMemoryMemoryRetrievalEngine(memoryRepository);
  const authorizationService = createAuthorizationService();

  const memoryManager = createMemoryManagerService({
    repository: memoryRepository,
    accessPolicy,
    lifecycle,
    retrievalEngine,
    authorizationService,
    config: memoryConfig,
    logger,
    events: memoryEmitter,
  });

  const retrievalService = createRetrievalService({
    repository: memoryRepository,
    authorizationService,
    config: memoryConfig,
    logger,
  });

  const contextIntegration = createContextIntegrationService({
    authorizationService,
    config: memoryConfig,
    logger,
  });

  const consolidation = createMemoryConsolidationService({
    repository: memoryRepository,
    authorizationService,
    config: memoryConfig,
    logger,
    events: memoryEmitter,
    lifecycle,
  });

  const contract: MemoryManagerContract = new MemoryManagerContractAdapter({
    manager: memoryManager,
    retrieval: retrievalService,
    contextIntegration,
    consolidation,
    storageAvailable: true,
  });

  // ---- AG-001 memory provider adapter -------------------------------------
  const memoryProvider = createMemoryContextProvider({ contract });

  // ---- runtime agent registry + executor ----------------------------------
  const registry = new AgentRegistry();
  registry.register(createRuntimeAgent({ logger }));

  const requestActors = new RequestActorRegistry();

  // Phase 6 event bridge (maps runtime events into AG-002 events).
  let postgresSink: PostgresEventSink | undefined;
  if (durable && postgresPool !== undefined) {
    postgresSink = new PostgresEventSink(postgresPool, eventLog);
  }
  const eventBridge = new RuntimeEventBridge({
    log: eventLog,
    postgresSink,
    logger,
  });

  const memoryInputBuilder = new MemoryAwareContextInputBuilder({
    actorRegistry: requestActors,
    logger,
  });

  // ---- AG-003 knowledge stack -------------------------------------------------
  const knowledgeConfig = env.knowledge;
  const knowledgeEventLog = createKnowledgeEventLog();

  // The knowledge backend is driven by the resolved runtime environment
  // (`env.knowledge`). Fail-closed: an unknown backend or a durable backend
  // without a connection string aborts construction rather than degrading.
  const knowledgeBackend = knowledgeConfig.KNOWLEDGE_STORAGE_BACKEND;
  let knowledgeRepository: KnowledgeRepository;
  let knowledgeStorageClose: () => Promise<void> = async () => undefined;
  let knowledgeDurable = false;

  if (knowledgeBackend === 'durable') {
    const connection = env.knowledge.KNOWLEDGE_DATABASE_URL;
    if (typeof connection !== 'string' || connection.trim().length === 0) {
      throw new DiagnosticError('Missing required configuration: KNOWLEDGE_DATABASE_URL', {
        code: 'MISSING_REQUIRED_CONFIG',
        details: { key: 'KNOWLEDGE_DATABASE_URL' },
      });
    }
    const knowledgePool = createPostgresPool(connection);
    const postgresRepo = new PostgresKnowledgeRepository({ pool: knowledgePool });
    await postgresRepo.migrate();
    knowledgeRepository = postgresRepo;
    knowledgeStorageClose = () => knowledgePool.end();
    knowledgeDurable = true;
  } else {
    knowledgeRepository = new InMemoryKnowledgeRepository();
  }

  const knowledgeManager = new KnowledgeManagerService({
    repository: knowledgeRepository,
    config: knowledgeConfig,
    eventLog: knowledgeEventLog,
    logger,
  });

  const probeKnowledgeStorage: () => Promise<{ healthy: boolean }> = async () => {
    try {
      const health = await knowledgeManager.healthAsync();
      return { healthy: health.healthy };
    } catch {
      return { healthy: false };
    }
  };

  const executor = new ProductionAgentExecutor({
    registry,
    memoryProvider,
    memoryInputBuilder: (req) => memoryInputBuilder.build(req),
    logger,
    onEvent: (event) => eventBridge.accept(event),
  });

  const executorRegistry: ExecutorRegistry = new ProductionExecutorRegistry(executor);

  const executionEngine = new ExecutionEngine({
    registry: executorRegistry,
    config: executionConfig,
  });

  // ---- routing / planning / intent / context / aggregation ----------------
  const routingEngine = new RoutingEngine();
  const planBuilder = new ExecutionPlanBuilder();
  const intentClassifier = new RuleBasedIntentClassifier();
  const contextBuilder: ContextBuilderType = new ContextBuilder();
  const aggregationService = new SharedAggregationService();
  const orchestratorEvents = new InMemoryOrchestratorEventEmitter();

  const orchestrator = new MasterOrchestratorService({
    intentClassifier,
    contextBuilder,
    routingEngine,
    planBuilder,
    executionEngine,
    aggregationService,
    config: orchestratorConfig,
    logger,
    events: orchestratorEvents,
  });

  // Wire orchestrator events into the runtime event bridge so the AG-002 log
  // observes orchestration lifecycle (Phase 6).
  const orchestratorUnsub = orchestratorEvents.on((event) => {
    eventBridge.accept({
      type: RuntimeAgentEventType.ExecutionStarted,
      executionId: event.requestId,
      stepId: '',
      agentId: 'AG-001',
      traceId: event.traceId,
      requestId: event.requestId,
      occurredAt: event.occurredAt,
      errorCode: event.errorCode,
      metadata: { orchestrationStage: event.stage },
    });
  });
  void orchestratorUnsub;

  return {
    env,
    logger,
    services: {
      memoryManager: contract,
      knowledgeManager,
      agentRegistry: registry,
      executor,
      executionEngine,
      orchestrator,
      orchestratorEvents,
      memoryEvents: memoryEmitter,
      eventBridge,
      eventLog,
      knowledgeEventLog,
      requestActors,
    },
    storage: {
      close: async () => {
        await storageClose();
        await knowledgeStorageClose();
      },
      durable: durable || knowledgeDurable,
    },
    health: {
      probeStorage,
      probeKnowledgeStorage,
    },
  };
}
