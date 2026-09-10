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

import {
  InMemoryToolRepository,
  ToolManagerService,
  PostgresToolRepository,
  ToolEventLog,
  createCalculatorSpecification,
  ToolActorGroup,
  type ToolRepository,
  type ToolActor,
} from '../agents/ag-004-tool-manager/index.js';

import { AIReasoningService, LLMEventLog, LLMMetrics, createLLMProvider } from '../llm/index.js';

import {
  AgenticLoopService,
  AgenticEventLog,
  AgenticLoopMetrics,
  AgenticToolManagerAdapter,
} from '../agents/runtime/agentic/index.js';
import type { AgenticToolActorBuilder } from '../agents/runtime/executor.js';
import {
  AgentDefinitionRegistry,
  AgentPlatformGateway,
  AgentPlatformMetrics,
  AgentPlatformEventLog,
  AgentExecutionMode,
  withPlatformAwareness,
} from '../agents/agent-platform/index.js';
import type { AgentDefinition } from '../agents/agent-platform/index.js';
import {
  ClientAIService,
  ClientContextBuilder,
  ClientTeamRouter,
  ClientToolClient,
  ClientWorkflowRegistry,
  createClientTeamAgents,
  createClientTeamAgentDefinitions,
} from '../agents/client-ai-team/index.js';
import {
  createFreelancerTeamAgents,
  createFreelancerTeamAgentDefinitions,
  FreelancerAIService,
  FreelancerContextBuilder,
  FreelancerTeamRouter,
  FreelancerToolClient,
  FreelancerWorkflowRegistry,
} from '../agents/freelancer-ai-team/index.js';
import {
  createMarketplaceTeamAgents,
  createMarketplaceTeamAgentDefinitions,
  MarketplaceAIService,
  MarketplaceContextBuilder,
  MarketplaceTeamRouter,
  MarketplaceToolClient,
  MarketplaceWorkflowRegistry,
} from '../agents/marketplace-ai-team/index.js';
import {
  createMarketingTeamAgents,
  createMarketingTeamAgentDefinitions,
  MarketingAIService,
  MarketingContextBuilder,
  MarketingTeamRouter,
  MarketingToolClient,
  MarketingWorkflowRegistry,
} from '../agents/marketing-ai-team/index.js';
import {
  createAdminTeamAgents,
  createAdminTeamAgentDefinitions,
  AdminAIService,
  AdminContextBuilder,
  AdminTeamRouter,
  AdminToolClient,
  AdminWorkflowRegistry,
} from '../agents/admin-ai-team/index.js';
import {
  AgentSelector,
  CoordinationCoordinator,
  CoordinationEventLog,
  CoordinationMetrics,
  CoordinationPlanner,
  RuntimeAgentInvocationAdapter,
} from '../agents/agent-platform/coordination/index.js';
import { RoutingRegistry } from '../agents/ag-001-master-orchestrator/routing/registry/index.js';
import { LLM_AGENTIC_CAPABILITY, LLM_REASONING_CAPABILITY } from '../llm/constants.js';

import type { Environment } from './env.js';
import { parseCompiledEnv } from './env.js';
import { AgentRegistry } from '../agents/runtime/registry.js';
import { ProductionAgentExecutor, ProductionExecutorRegistry } from '../agents/runtime/executor.js';
import { RuntimeAgentEventType } from '../agents/runtime/types.js';
import { createRuntimeAgent } from '../agents/runtime/runtime-agent.js';
import type { RuntimeAgent } from '../agents/runtime/types.js';
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
    readonly toolManager: ToolManagerService;
    readonly agentRegistry: AgentRegistry;
    readonly executor: ProductionAgentExecutor;
    readonly executionEngine: ExecutionEngine;
    readonly orchestrator: MasterOrchestratorService;
    readonly orchestratorEvents: InMemoryOrchestratorEventEmitter;
    readonly memoryEvents: InMemoryMemoryEventEmitter;
    readonly eventBridge: RuntimeEventBridge;
    readonly eventLog: InMemoryEventLog;
    readonly knowledgeEventLog: KnowledgeEventLog;
    readonly toolEventLog: ToolEventLog;
    /** AI reasoning capability (Sprint 17, fail-closed via config). */
    readonly aiReasoning: AIReasoningService;
    /** LLM event trail (Sprint 17). */
    readonly llmEventLog: LLMEventLog;
    /** LLM metrics (Sprint 17). */
    readonly llmMetrics: LLMMetrics;
    /** Agentic tool-calling loop (Sprint 18). */
    readonly agenticLoop: AgenticLoopService;
    /** Agentic event trail (Sprint 18). */
    readonly agenticEventLog: AgenticEventLog;
    /** Agentic metrics (Sprint 18). */
    readonly agenticMetrics: AgenticLoopMetrics;
    /** Sprint 19 agent platform execution gate. */
    readonly platformGateway: AgentPlatformGateway;
    /** Sprint 19 agent definition/lifecycle registry (catalog + readiness). */
    readonly platformRegistry: AgentDefinitionRegistry;
    /** Sprint 19 policy metrics. */
    readonly platformMetrics: AgentPlatformMetrics;
    /** Sprint 19 platform event trail. */
    readonly platformEventLog: AgentPlatformEventLog;
    /** Sprint 20 multi-agent coordination coordinator. */
    readonly coordination: CoordinationCoordinator;
    /** Sprint 20 coordination planner (decomposition + agent selection). */
    readonly coordinationPlanner: CoordinationPlanner;
    /** Sprint 20 coordination event trail. */
    readonly coordinationEventLog: CoordinationEventLog;
    /** Sprint 20 coordination metrics. */
    readonly coordinationMetrics: CoordinationMetrics;
    /** Sprint 21 client AI team service (Client AI). */
    readonly clientAi: ClientAIService;
    /** Sprint 22 freelancer AI team service (Freelancer AI). */
    readonly freelancerAi: FreelancerAIService;
    /** Sprint 23 marketplace AI team service (Marketplace AI). */
    readonly marketplaceAi: MarketplaceAIService;
    /** Sprint 24 marketing AI team service (Marketing AI). */
    readonly marketingAi: MarketingAIService;
    /** Sprint 25 admin AI team service (Admin AI). */
    readonly adminAi: AdminAIService;
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
    readonly probeToolStorage: () => Promise<{ healthy: boolean }>;
    /** Sprint 21 client AI team readiness probe. */
    readonly probeClientTeam: () => Promise<{ healthy: boolean }>;
    /** Sprint 22 freelancer AI team readiness probe. */
    readonly probeFreelancerTeam: () => Promise<{ healthy: boolean }>;
    /** Sprint 23 marketplace AI team readiness probe. */
    readonly probeMarketplaceTeam: () => Promise<{ healthy: boolean }>;
    /** Sprint 24 marketing AI team readiness probe. */
    readonly probeMarketingTeam: () => Promise<{ healthy: boolean }>;
    /** Sprint 25 admin AI team readiness probe. */
    readonly probeAdminTeam: () => Promise<{ healthy: boolean }>;
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
 * Derives a Sprint 19 platform definition that mirrors a registered runtime
 * agent (Sprint 19 §24). The definition is validated at registration time; the
 * executor claims exactly these capability/permission ids at the gate, so the
 * mirror must stay aligned with the runtime agent manifest. Tool access is
 * fail-closed (empty allowlist) until explicitly granted.
 */
function agentDefinitionFromRuntimeAgent(agent: RuntimeAgent): AgentDefinition {
  const { configuration } = agent;
  const requiresAgentic = configuration.capabilities.some(
    (capability) => capability.id === LLM_AGENTIC_CAPABILITY,
  );
  const requiresReasoning = configuration.capabilities.some(
    (capability) => capability.id === LLM_REASONING_CAPABILITY,
  );
  const executionModes = requiresAgentic
    ? [AgentExecutionMode.Agentic]
    : requiresReasoning
      ? [AgentExecutionMode.Deterministic, AgentExecutionMode.Reasoning]
      : [AgentExecutionMode.Deterministic];
  return {
    agentId: configuration.agentId,
    name: configuration.name,
    version: configuration.version,
    description: `${configuration.name} (platform mirror of the runtime agent)`,
    team: 'platform',
    category: configuration.category,
    status: configuration.status,
    capabilities: configuration.capabilities.map((capability) => ({
      id: capability.id,
      name: capability.name,
      description: capability.description,
      enabled: capability.enabled,
    })),
    executionModes,
    allowedTools: [],
    permissions: configuration.permissions ?? [],
    limits: {
      maxExecutionTimeMs: 30_000,
      maxReasoningTurns: requiresAgentic ? 8 : 0,
      maxToolCalls: requiresAgentic ? 6 : 0,
      maxContextBytes: 65_536,
      maxOutputBytes: 65_536,
      maxConcurrentExecutions: 4,
    },
    dependencies: [],
    configuration: {},
  };
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
  // Sprint 21 client AI team runtime agents (AG-102..AG-105).
  for (const clientAgent of createClientTeamAgents()) {
    registry.register(clientAgent);
  }
  // Sprint 22 freelancer AI team runtime agents (AG-201/AG-202/AG-206/AG-207).
  for (const freelancerAgent of createFreelancerTeamAgents()) {
    registry.register(freelancerAgent);
  }
  // Sprint 23 marketplace AI team runtime agents (AG-301..AG-306).
  for (const marketplaceAgent of createMarketplaceTeamAgents()) {
    registry.register(marketplaceAgent);
  }
  // Sprint 24 marketing AI team runtime agents (AG-401..AG-405).
  for (const marketingAgent of createMarketingTeamAgents()) {
    registry.register(marketingAgent);
  }
  // Sprint 25 admin AI team runtime agents (AG-501..AG-505).
  for (const adminAgent of createAdminTeamAgents()) {
    registry.register(adminAgent);
  }

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

  // ---- AG-004 tool stack ---------------------------------------------------
  const toolConfig = env.tools;
  const toolEventLog = new ToolEventLog();

  // The tool backend is driven by the resolved runtime environment
  // (`env.tools`). Fail-closed: an unknown backend or a durable backend without
  // a connection string aborts construction rather than degrading. The database
  // URL is reused from the shared memory config when present (never duplicated).
  const toolBackend = toolConfig.TOOLS_STORAGE_BACKEND;
  const toolsEnabled = toolConfig.TOOLS_ENABLED;
  let toolRepository: ToolRepository = new InMemoryToolRepository();
  let toolStorageClose: () => Promise<void> = async () => undefined;
  let toolDurable = false;

  if (toolsEnabled && toolBackend === 'durable') {
    const connection =
      env.memory.MEMORY_DATABASE_URL !== '' && env.memory.MEMORY_DATABASE_URL !== undefined
        ? env.memory.MEMORY_DATABASE_URL
        : toolConfig.TOOLS_DATABASE_URL;
    if (typeof connection !== 'string' || connection.trim().length === 0) {
      throw new DiagnosticError('Missing required configuration: tools database URL', {
        code: 'MISSING_REQUIRED_CONFIG',
        details: { key: 'TOOLS_DATABASE_URL' },
      });
    }
    const toolPool = createPostgresPool(connection);
    const postgresToolRepo = new PostgresToolRepository({ pool: toolPool });
    await postgresToolRepo.migrate();
    toolRepository = postgresToolRepo;
    toolStorageClose = () => toolPool.end();
    toolDurable = true;
  }

  const toolManager = new ToolManagerService({
    repository: toolRepository,
    config: toolConfig,
    eventLog: toolEventLog,
    logger,
  });

  // Register the built-in calculator tool (genuinely executable, safe).
  if (toolsEnabled && !toolManager.exists('calculator')) {
    const bootstrapActor: ToolActor = {
      group: ToolActorGroup.ToolManager,
      id: 'composition-root',
      namespaces: ['default'],
    };
    await toolManager.register(createCalculatorSpecification(), bootstrapActor, 'default');
  }

  const probeToolStorage: () => Promise<{ healthy: boolean }> = async () => {
    try {
      const health = await toolManager.healthAsync();
      return { healthy: health.healthy };
    } catch {
      return { healthy: false };
    }
  };

  // ---- LLM + AI reasoning stack (Sprint 17) --------------------------------
  // Fail-closed by configuration: when `LLM_ENABLED` is false the executor
  // rejects reasoning-capable agents with REASONING_UNAVAILABLE; the provider
  // is never constructed with live credentials unless explicitly enabled.
  const llmEventLog = new LLMEventLog();
  const llmMetrics = new LLMMetrics();
  const llmProvider = createLLMProvider(env.llm);
  const aiReasoning = new AIReasoningService({
    provider: llmProvider,
    config: env.llm,
    eventLog: llmEventLog,
    metrics: llmMetrics,
  });

  // ---- agentic tool-calling loop (Sprint 18) ------------------------------
  // Wraps AG-004 exclusively through the narrow coordinator port and reuses
  // the same reasoning stack. Independent event log + metrics for observability.
  const agenticEventLog = new AgenticEventLog();
  const agenticMetrics = new AgenticLoopMetrics();
  const agenticLoop = new AgenticLoopService({
    reasoning: aiReasoning,
    tools: new AgenticToolManagerAdapter(toolManager),
    config: env.agentic,
    eventLog: agenticEventLog,
    metrics: agenticMetrics,
    logger,
    defaultNamespace: 'default',
  });

  const agenticToolActor: AgenticToolActorBuilder = (req) => {
    const actor = requestActors.resolve(req.executionId);
    return actor === undefined
      ? {
          group: ToolActorGroup.Orchestrator,
          id: `agentic-${req.agentId}`,
          namespaces: ['default'],
        }
      : {
          group: ToolActorGroup.Orchestrator,
          id: actor.actorId ?? `agentic-${req.agentId}`,
          namespaces: actor.namespaces.length > 0 ? actor.namespaces : ['default'],
        };
  };

  // ---- Sprint 19 agent platform (capability framework + lifecycle gate) ----
  const platformMetrics = new AgentPlatformMetrics();
  const platformEventLog = new AgentPlatformEventLog();
  const platformRegistry = new AgentDefinitionRegistry({
    metrics: platformMetrics,
    eventLog: platformEventLog,
    toolExists: (toolName) => toolsEnabled && toolManager.exists(toolName),
  });

  // AG-101 mirrors the registered runtime agent so the executor's capability
  // claims always match the platform definition (identity + capability are the
  // same contract, seen from two layers). Optional forward references are the
  // only dependencies allowed; AG-102 depends on AG-101 (non-blocking).
  const runtimeAgent101 = registry.get('AG-101');
  if (runtimeAgent101 === undefined) {
    throw new DiagnosticError('AG-101 runtime agent is not registered', {
      code: 'PLATFORM_AGENT_MIRROR_MISSING',
      details: { agentId: 'AG-101' },
    });
  }
  platformRegistry.registerAgent(agentDefinitionFromRuntimeAgent(runtimeAgent101), {
    activate: true,
  });
  // Sprint 21 client platform mirrors (AG-102..AG-105). Definitions own their
  // dependencies (AG-101 forward references) since the runtime mirror builder
  // cannot express them. Tool access stays fail-closed unless tools are enabled.
  for (const clientDefinition of createClientTeamAgentDefinitions({ toolsEnabled })) {
    platformRegistry.registerAgent(clientDefinition, { activate: true });
  }
  // Sprint 22 freelancer platform mirrors (AG-201/AG-202/AG-206/AG-207).
  // Deterministic-only v1: the definitions ship an empty tool allowlist, so
  // agentic tool access fails closed until a tool is explicitly enabled.
  for (const freelancerDefinition of createFreelancerTeamAgentDefinitions()) {
    platformRegistry.registerAgent(freelancerDefinition, { activate: true });
  }
  // Sprint 23 marketplace platform mirrors (AG-301..AG-306).
  // Deterministic-only v1 with an empty tool allowlist (fail-closed tooling).
  for (const marketplaceDefinition of createMarketplaceTeamAgentDefinitions()) {
    platformRegistry.registerAgent(marketplaceDefinition, { activate: true });
  }
  // Sprint 24 marketing platform mirrors (AG-401..AG-405).
  // Deterministic-only v1 with an empty tool allowlist (fail-closed tooling).
  for (const marketingDefinition of createMarketingTeamAgentDefinitions()) {
    platformRegistry.registerAgent(marketingDefinition, { activate: true });
  }
  // Sprint 25 admin platform mirrors (AG-501..AG-505).
  // Deterministic-only v1 with an empty tool allowlist (fail-closed tooling).
  // Privileged capabilities (admin.*) are scoped and approval-gated (BR-ADM-1).
  for (const adminDefinition of createAdminTeamAgentDefinitions()) {
    platformRegistry.registerAgent(adminDefinition, { activate: true });
  }

  const platformGateway = new AgentPlatformGateway({
    registry: platformRegistry,
    metrics: platformMetrics,
    eventLog: platformEventLog,
  });

  const executor = new ProductionAgentExecutor({
    registry,
    memoryProvider,
    memoryInputBuilder: (req) => memoryInputBuilder.build(req),
    reasoningService: aiReasoning,
    agenticLoop,
    agenticToolActor,
    agentPlatform: platformGateway,
    logger,
    onEvent: (event) => eventBridge.accept(event),
  });

  const executorRegistry: ExecutorRegistry = new ProductionExecutorRegistry(executor);

  // ---- Sprint 20 multi-agent coordination (reusable infrastructure) --------
  // Sits strictly ABOVE the Sprint 19 platform; the coordinator drives agents
  // ONLY through the runtime executor (which enforces the platform gate).
  const coordinationSelector = new AgentSelector({
    registry: platformRegistry,
    gateway: platformGateway,
    executorRegistry,
  });
  const coordinationPlanner = new CoordinationPlanner(coordinationSelector);
  const coordinationEventLog = new CoordinationEventLog();
  const coordinationMetrics = new CoordinationMetrics();
  const coordinationInvocation = new RuntimeAgentInvocationAdapter({ executorRegistry });
  const coordination = new CoordinationCoordinator({
    planner: coordinationPlanner,
    invocation: coordinationInvocation,
    eventLog: coordinationEventLog,
    metrics: coordinationMetrics,
  });

  // ---- Sprint 21 client AI team (deterministic-first service) --------------
  // Builds bounded AG-002/AG-003 context, routes through AG-001 intent, drives
  // single agents through the platform-gated executor, and runs coordination
  // workflows for project creation. Tools go strictly through the platform
  // allowlist + AG-004; agentic mode is only available when the loop is on.
  const clientContextBuilder = new ClientContextBuilder({
    memory: contract,
    knowledge: knowledgeManager,
    logger,
  });
  const clientRouter = new ClientTeamRouter({ selector: coordinationSelector });
  const clientWorkflows = new ClientWorkflowRegistry({ selector: coordinationSelector });
  const clientToolClient = new ClientToolClient({ gateway: platformGateway, toolManager });
  const clientAi = new ClientAIService({
    router: clientRouter,
    workflows: clientWorkflows,
    contextBuilder: clientContextBuilder,
    coordination,
    executorRegistry,
    gateway: platformGateway,
    toolClient: clientToolClient,
    agenticLoop,
    logger,
  });

  // ---- Sprint 22 freelancer AI team (deterministic-first service) ----------
  // Mirrors the client team: bounded AG-002/AG-003 context under the
  // FREELANCER actor groups, AG-001 intent routing, platform-gated execution,
  // a coordination pipeline for proposal generation, and AG-004 tool access
  // that fails closed (freelancer agents ship with an empty allowlist).
  const freelancerContextBuilder = new FreelancerContextBuilder({
    memory: contract,
    knowledge: knowledgeManager,
    logger,
  });
  const freelancerRouter = new FreelancerTeamRouter({ selector: coordinationSelector });
  const freelancerWorkflows = new FreelancerWorkflowRegistry({ selector: coordinationSelector });
  const freelancerToolClient = new FreelancerToolClient({
    gateway: platformGateway,
    toolManager,
  });
  const freelancerAi = new FreelancerAIService({
    router: freelancerRouter,
    workflows: freelancerWorkflows,
    contextBuilder: freelancerContextBuilder,
    coordination,
    executorRegistry,
    gateway: platformGateway,
    toolClient: freelancerToolClient,
    agenticLoop,
    logger,
  });

  // ---- Sprint 23 marketplace AI team (deterministic-first service) ---------
  // Mirrors the client/freelancer teams: bounded AG-002/AG-003 context under
  // the MARKETPLACE actor groups, AG-001 intent routing, platform-gated
  // execution, a coordination workflow for engagement scoping, AG-004 tool
  // access that fails closed, and data-honest marketplace intelligence
  // (insufficient-data signals never fabricate prices or trends).
  const marketplaceContextBuilder = new MarketplaceContextBuilder({
    memory: contract,
    knowledge: knowledgeManager,
    logger,
  });
  const marketplaceRouter = new MarketplaceTeamRouter({ selector: coordinationSelector });
  const marketplaceWorkflows = new MarketplaceWorkflowRegistry({
    selector: coordinationSelector,
  });
  const marketplaceToolClient = new MarketplaceToolClient({
    gateway: platformGateway,
    toolManager,
  });
  const marketplaceAi = new MarketplaceAIService({
    router: marketplaceRouter,
    workflows: marketplaceWorkflows,
    contextBuilder: marketplaceContextBuilder,
    coordination,
    executorRegistry,
    gateway: platformGateway,
    toolClient: marketplaceToolClient,
    agenticLoop,
    logger,
  });

  // ---- Sprint 24 marketing AI team (deterministic-first service) -----------
  // Mirrors the client/freelancer/marketplace teams: bounded AG-002/AG-003
  // context under the MARKETING actor groups, AG-001 intent routing,
  // platform-gated execution, a coordination workflow for campaign content
  // briefs, AG-004 tool access that fails closed, and data-honest marketing
  // intelligence (research insights, social/blog/email drafts and SEO
  // recommendations never fabricate claims, metrics or promises).
  const marketingContextBuilder = new MarketingContextBuilder({
    memory: contract,
    knowledge: knowledgeManager,
    logger,
  });
  const marketingRouter = new MarketingTeamRouter({ selector: coordinationSelector });
  const marketingWorkflows = new MarketingWorkflowRegistry({
    selector: coordinationSelector,
  });
  const marketingToolClient = new MarketingToolClient({
    gateway: platformGateway,
    toolManager,
  });
  const marketingAi = new MarketingAIService({
    router: marketingRouter,
    workflows: marketingWorkflows,
    contextBuilder: marketingContextBuilder,
    coordination,
    executorRegistry,
    gateway: platformGateway,
    toolClient: marketingToolClient,
    agenticLoop,
    logger,
  });

  // ---- Sprint 25 admin AI team (deterministic-first, privileged service) --
  // Mirrors the marketing team shape but for Admin actors: bounded AG-002/AG-003
  // context under the ADMIN actor groups (never row-level user data), AG-001
  // admin intent routing, authorization before execution (BR-ADM-1), approval
  // stamping for mutating recommendations (BR-ADM-2), safe audit events
  // (BR-ADM-3), reversible feature-flagged AI-management proposals (BR-ADM-4),
  // a parallel executive-review workflow (AG-505), and AG-004 tool access that
  // fails closed. Admin agents never fabricate metrics and never execute writes.
  const adminContextBuilder = new AdminContextBuilder({
    memory: contract,
    knowledge: knowledgeManager,
    logger,
  });
  const adminRouter = new AdminTeamRouter({ selector: coordinationSelector });
  const adminWorkflows = new AdminWorkflowRegistry({
    selector: coordinationSelector,
  });
  const adminToolClient = new AdminToolClient({
    gateway: platformGateway,
    toolManager,
  });
  const adminAi = new AdminAIService({
    router: adminRouter,
    workflows: adminWorkflows,
    contextBuilder: adminContextBuilder,
    coordination,
    executorRegistry,
    gateway: platformGateway,
    toolClient: adminToolClient,
    agenticLoop,
    logger,
  });

  const executionEngine = new ExecutionEngine({
    registry: executorRegistry,
    config: executionConfig,
  });

  // ---- routing / planning / intent / context / aggregation ----------------
  // The routing registry is decorated so platform-managed agents expose their
  // live lifecycle (READY/RUNNING only) as routing availability.
  const routingRegistry = withPlatformAwareness(new RoutingRegistry(), platformRegistry);
  const routingEngine = new RoutingEngine({ registry: routingRegistry });
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
      toolManager,
      agentRegistry: registry,
      executor,
      executionEngine,
      orchestrator,
      orchestratorEvents,
      memoryEvents: memoryEmitter,
      eventBridge,
      eventLog,
      knowledgeEventLog,
      toolEventLog,
      aiReasoning,
      llmEventLog,
      llmMetrics,
      agenticLoop,
      agenticEventLog,
      agenticMetrics,
      platformGateway,
      platformRegistry,
      platformMetrics,
      platformEventLog,
      coordination,
      coordinationPlanner,
      coordinationEventLog,
      coordinationMetrics,
      clientAi,
      freelancerAi,
      marketplaceAi,
      marketingAi,
      adminAi,
      requestActors,
    },
    storage: {
      close: async () => {
        await storageClose();
        await knowledgeStorageClose();
        await toolStorageClose();
      },
      durable: durable || knowledgeDurable || toolDurable,
    },
    health: {
      probeStorage,
      probeKnowledgeStorage,
      probeToolStorage,
      probeClientTeam: async () => ({ healthy: clientAi.status().healthy }),
      probeFreelancerTeam: async () => ({ healthy: freelancerAi.status().healthy }),
      probeMarketplaceTeam: async () => ({ healthy: marketplaceAi.status().healthy }),
      probeMarketingTeam: async () => ({ healthy: marketingAi.status().healthy }),
      probeAdminTeam: async () => ({ healthy: adminAi.status().healthy }),
    },
  };
}
