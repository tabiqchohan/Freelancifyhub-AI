import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';

import type { UserRole } from '../agents/ag-001-master-orchestrator/intent/index.js';
import { UserRole as UserRoleValue } from '../agents/ag-001-master-orchestrator/intent/index.js';
import type {
  OrchestrationRequest,
  OrchestratorResponse,
} from '../agents/ag-001-master-orchestrator/orchestrator/types/index.js';
import type { MemoryActorGroup } from '../agents/ag-002-memory-manager/index.js';
import { MemoryActorGroup as MemoryActorGroupValue } from '../agents/ag-002-memory-manager/index.js';
import {
  KnowledgeActorGroup,
  KnowledgeContentType,
  KnowledgeSecurityLevel,
  KnowledgeSourceType,
} from '../agents/ag-003-knowledge-manager/index.js';
import {
  ToolActorGroup,
  ToolResultStatus,
  ToolSecurityLevel,
  type ToolActor,
} from '../agents/ag-004-tool-manager/index.js';

import { KnowledgeAccessDeniedError } from '../agents/ag-003-knowledge-manager/index.js';

import type { ProductionComposition } from './composition-root.js';
import type { RequestActorBinding } from './request-actors.js';
import { agenticLimitSummary } from '../agents/runtime/agentic/config.js';
import type { AgentPlatformStatusSnapshot } from '../agents/agent-platform/index.js';
import { toAiosError } from '../ai-operating-system/index.js';
import type { AiosRequest } from '../ai-operating-system/index.js';

/** Hard deadline for a readiness probe so a hung dependency cannot stall
 * infrastructure health checks (Sprint 34). */
export const READINESS_PROBE_TIMEOUT_MS = 2_000;

/** Options for constructing the production HTTP runtime (Phase 7). */
export interface ProductionRuntimeOptions {
  readonly composition: ProductionComposition;
  readonly logger: Logger;
  /** Health/readiness payload builder; omit for default (no storage probe). */
  readonly healthCheck?: () => Promise<HealthPayload>;
  /**
   * Server-to-server token required on business endpoints. Defaults to the
   * parsed environment value (`AIOS_SERVICE_TOKEN`). Sprint 35 F-4: when empty
   * the runtime DENIES business endpoints unless `allowUnauthenticated` is set.
   */
  readonly serviceToken?: string;
  /**
   * Sprint 35 F-3 — dedicated credential required for management operations
   * (AG-004 tool enable/disable). Defaults to `AIOS_ADMIN_TOKEN`. When empty,
   * management endpoints are denied outright.
   */
  readonly adminToken?: string;
  /**
   * Sprint 35 F-4 — explicit opt-in for running the business API with no service
   * token. Default `false`; always ignored when `NODE_ENV=production`.
   */
  readonly allowUnauthenticated?: boolean;
}

/** The health/readiness payload exposed at `/healthz` (Phase 8). */
export interface HealthPayload {
  readonly status: 'ok' | 'degraded';
  readonly uptime: number;
  readonly storage: { healthy: boolean };
  readonly knowledge: { healthy: boolean };
  readonly tools: { healthy: boolean };
  /** LLM config status (Sprint 17). Never performs a live connectivity probe. */
  readonly llm: { enabled: boolean; configured: boolean; provider: string; model: string };
  /** Sprint 19 agent platform status (safe aggregate; never secrets). */
  readonly platform: AgentPlatformStatusSnapshot;
  /** Sprint 20 multi-agent coordination status (safe aggregate; never secrets). */
  readonly coordination: CoordinationHealthSnapshot;
  /** Sprint 21 client AI team status (safe aggregate; never secrets). */
  readonly clientTeam: ClientTeamHealthSnapshot;
  /** Sprint 22 freelancer AI team status (safe aggregate; never secrets). */
  readonly freelancerTeam: FreelancerTeamHealthSnapshot;
  /** Sprint 23 marketplace AI team status (safe aggregate; never secrets). */
  readonly marketplaceTeam: MarketplaceTeamHealthSnapshot;
  /** Sprint 24 marketing AI team status (safe aggregate; never secrets). */
  readonly marketingTeam: MarketingTeamHealthSnapshot;
  /** Sprint 25 admin AI team status (safe aggregate; never secrets). */
  readonly adminTeam: AdminTeamHealthSnapshot;
  /** Sprint 26 AI Operating System status (safe aggregate; never secrets). */
  readonly aiOperatingSystem: AiosHealthSnapshot;
}

/** Safe AI Operating System snapshot for the runtime health block. */
export interface AiosHealthSnapshot {
  readonly enabled: boolean;
  readonly healthy: boolean;
  readonly activeRequests: number;
  readonly completedRequests: number;
  readonly requestCounts: Readonly<Record<string, number>>;
  readonly statusCounts: Readonly<Record<string, number>>;
}

/** Safe coordination health snapshot for the runtime health block. */
export interface CoordinationHealthSnapshot {
  readonly healthy: boolean;
  readonly activeCoordinations: number;
  readonly activeTaskCount: number;
  readonly eventCount: number;
}

/** Safe client AI team snapshot for the runtime health block. */
export interface ClientTeamHealthSnapshot {
  readonly healthy: boolean;
  readonly enabled: boolean;
  readonly activeAgents: number;
  readonly establishedAgents: number;
  readonly workflows: readonly string[];
  readonly eventCount: number;
}

/** Safe freelancer AI team snapshot for the runtime health block. */
export interface FreelancerTeamHealthSnapshot {
  readonly healthy: boolean;
  readonly enabled: boolean;
  readonly activeAgents: number;
  readonly establishedAgents: number;
  readonly workflows: readonly string[];
  readonly eventCount: number;
}

/** Safe marketplace AI team snapshot for the runtime health block. */
export interface MarketplaceTeamHealthSnapshot {
  readonly healthy: boolean;
  readonly enabled: boolean;
  readonly activeAgents: number;
  readonly establishedAgents: number;
  readonly workflows: readonly string[];
  readonly eventCount: number;
}

/** Safe marketing AI team snapshot for the runtime health block. */
export interface MarketingTeamHealthSnapshot {
  readonly healthy: boolean;
  readonly enabled: boolean;
  readonly activeAgents: number;
  readonly establishedAgents: number;
  readonly workflows: readonly string[];
  readonly eventCount: number;
}

/** Safe admin AI team snapshot for the runtime health block. */
export interface AdminTeamHealthSnapshot {
  readonly healthy: boolean;
  readonly enabled: boolean;
  readonly activeAgents: number;
  readonly establishedAgents: number;
  readonly workflows: readonly string[];
  readonly eventCount: number;
}

/** Default coordination health snapshot when the layer is absent. */
export function defaultCoordinationHealth(): CoordinationHealthSnapshot {
  return { healthy: true, activeCoordinations: 0, activeTaskCount: 0, eventCount: 0 };
}

/** Default health payload; never surfaces secrets or connection strings. */
export async function defaultHealth(
  checkStorage: ProductionComposition['health']['probeStorage'],
  checkKnowledge?: ProductionComposition['health']['probeKnowledgeStorage'],
  checkTools?: ProductionComposition['health']['probeToolStorage'],
  llmInfo?: () => { enabled: boolean; configured: boolean; provider: string; model: string },
  platformInfo?: () => AgentPlatformStatusSnapshot,
  coordinationInfo?: () => CoordinationHealthSnapshot,
  clientTeamInfo?: () => ClientTeamHealthSnapshot,
  freelancerTeamInfo?: () => FreelancerTeamHealthSnapshot,
  marketplaceTeamInfo?: () => MarketplaceTeamHealthSnapshot,
  marketingTeamInfo?: () => MarketingTeamHealthSnapshot,
  adminTeamInfo?: () => AdminTeamHealthSnapshot,
  aiosInfo?: () => AiosHealthSnapshot,
): Promise<HealthPayload> {
  const storageHealth = await checkStorage();
  const knowledgeHealth = checkKnowledge !== undefined ? await checkKnowledge() : { healthy: true };
  const toolsHealth = checkTools !== undefined ? await checkTools() : { healthy: true };
  return {
    status:
      storageHealth.healthy && knowledgeHealth.healthy && toolsHealth.healthy ? 'ok' : 'degraded',
    uptime: process.uptime(),
    storage: { healthy: storageHealth.healthy },
    knowledge: { healthy: knowledgeHealth.healthy },
    tools: { healthy: toolsHealth.healthy },
    llm: llmInfo?.() ?? { enabled: false, configured: false, provider: 'disabled', model: '' },
    platform: platformInfo?.() ?? {
      registered: 0,
      ready: 0,
      running: 0,
      paused: 0,
      draining: 0,
      disabled: 0,
      failed: 0,
      terminated: 0,
      activeExecutions: 0,
      healthy: false,
    },
    coordination: coordinationInfo?.() ?? defaultCoordinationHealth(),
    clientTeam: clientTeamInfo?.() ?? defaultClientTeamHealth(),
    freelancerTeam: freelancerTeamInfo?.() ?? defaultFreelancerTeamHealth(),
    marketplaceTeam: marketplaceTeamInfo?.() ?? defaultMarketplaceTeamHealth(),
    marketingTeam: marketingTeamInfo?.() ?? defaultMarketingTeamHealth(),
    adminTeam: adminTeamInfo?.() ?? defaultAdminTeamHealth(),
    aiOperatingSystem: aiosInfo?.() ?? defaultAiosHealth(),
  };
}

/** Default AI Operating System snapshot when the layer is absent. */
export function defaultAiosHealth(): AiosHealthSnapshot {
  return {
    enabled: false,
    healthy: false,
    activeRequests: 0,
    completedRequests: 0,
    requestCounts: {},
    statusCounts: {},
  };
}

/** Default client AI team snapshot when the layer is absent. */
export function defaultClientTeamHealth(): ClientTeamHealthSnapshot {
  return {
    healthy: false,
    enabled: false,
    activeAgents: 0,
    establishedAgents: 0,
    workflows: [],
    eventCount: 0,
  };
}

/** Default freelancer AI team snapshot when the layer is absent. */
export function defaultFreelancerTeamHealth(): FreelancerTeamHealthSnapshot {
  return {
    healthy: false,
    enabled: false,
    activeAgents: 0,
    establishedAgents: 0,
    workflows: [],
    eventCount: 0,
  };
}

/** Default marketplace AI team snapshot when the layer is absent. */
export function defaultMarketplaceTeamHealth(): MarketplaceTeamHealthSnapshot {
  return {
    healthy: false,
    enabled: false,
    activeAgents: 0,
    establishedAgents: 0,
    workflows: [],
    eventCount: 0,
  };
}

/** Default marketing AI team snapshot when the layer is absent. */
export function defaultMarketingTeamHealth(): MarketingTeamHealthSnapshot {
  return {
    healthy: false,
    enabled: false,
    activeAgents: 0,
    establishedAgents: 0,
    workflows: [],
    eventCount: 0,
  };
}

/** Default admin AI team snapshot when the layer is absent. */
export function defaultAdminTeamHealth(): AdminTeamHealthSnapshot {
  return {
    healthy: false,
    enabled: false,
    activeAgents: 0,
    establishedAgents: 0,
    workflows: [],
    eventCount: 0,
  };
}

/** Body shape accepted at the runtime request endpoint. */
export interface RuntimeRequestInput {
  readonly text: string;
  readonly role?: UserRole;
  readonly requestId?: string;
  readonly traceId?: string;
  /** Memory actor scope for the request (Phase 5 wiring). */
  readonly actor?: {
    readonly group?: MemoryActorGroup;
    readonly id?: string;
    readonly role?: string;
    readonly namespaces?: readonly string[];
    readonly organizationId?: string;
    readonly workspaceId?: string;
    readonly projectIds?: readonly string[];
    readonly securityClearance?: string;
  };
}

/** Raw parsed JSON body of an incoming request. */
export type RuntimeRequestBody = RuntimeRequestInput;

/** Body shape accepted when creating knowledge at `POST /api/knowledge`. */
export interface KnowledgeCreateBody {
  readonly title: string;
  readonly content: string;
  readonly contentType?: 'plain_text' | 'markdown' | 'json' | 'html';
  readonly namespace?: string;
  readonly securityLevel?: 'INTERNAL' | 'CONFIDENTIAL';
  readonly sourceType?: string;
  readonly reference?: string;
  readonly metadata?: Record<string, unknown>;
  readonly actorGroup?: string;
  readonly actorId?: string;
}

/** Body shape accepted when executing a tool at `POST /api/tools/:id/execute`. */
export interface ToolExecuteBody {
  readonly input?: unknown;
  readonly namespace?: string;
  readonly actorGroup?: string;
  readonly actorId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly timeoutMs?: number;
}

/** Body shape accepted at the Sprint 26 AIOS request endpoint. */
export interface AiosRequestInput {
  readonly text: string;
  readonly structured?: Readonly<Record<string, unknown>>;
  readonly role?: string;
  readonly actorId?: string;
  readonly actorGroup?: string;
  readonly namespaces?: readonly string[];
  readonly adminScopes?: readonly string[];
  readonly securityClearance?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Phase 7 — Production runtime HTTP entry point.
 *
 * Wires the composition root to a minimal Node HTTP server. Preserves the
 * existing `/healthz` (and `/health`) liveness semantics, adds a JSON request
 * endpoint that routes text through the real orchestrator and (optionally)
 * binds the request's memory actor via {@link RequestActorRegistry}, and
 * supports graceful shutdown that closes storage handles.
 */
export class ProductionRuntime {
  private readonly composition: ProductionComposition;
  private readonly logger: Logger;
  private readonly healthCheck: () => Promise<HealthPayload>;
  private readonly serviceToken: string;
  private readonly adminToken: string;
  private readonly allowUnauthenticated: boolean;
  private server: Server | undefined;
  private shuttingDown = false;

  constructor(options: ProductionRuntimeOptions) {
    this.composition = options.composition;
    this.logger = options.logger;
    this.serviceToken =
      options.serviceToken ?? options.composition.env.base.AIOS_SERVICE_TOKEN ?? '';
    // Sprint 35 F-3 — the admin credential is never taken from the request; it is
    // server configuration only.
    this.adminToken = options.adminToken ?? options.composition.env.base.AIOS_ADMIN_TOKEN ?? '';
    // Sprint 35 F-4 — fail-closed by default. The explicit opt-in is honoured only
    // outside production, so it can never reopen a production deployment.
    const allowUnauthenticated =
      options.allowUnauthenticated ??
      options.composition.env.base.AIOS_ALLOW_UNAUTHENTICATED === true;
    this.allowUnauthenticated =
      allowUnauthenticated && options.composition.env.base.NODE_ENV !== 'production';
    this.healthCheck =
      options.healthCheck ??
      (() =>
        defaultHealth(
          options.composition.health.probeStorage,
          options.composition.health.probeKnowledgeStorage,
          options.composition.health.probeToolStorage,
          () => options.composition.services.aiReasoning.providerInfo(),
          () => options.composition.services.platformRegistry.snapshot(),
          () => {
            const status = options.composition.services.coordination.status();
            return {
              healthy: status.healthy,
              activeCoordinations: status.activeCoordinations,
              activeTaskCount: status.activeTaskCount,
              eventCount: status.eventCount,
            };
          },
          () => {
            const status = options.composition.services.clientAi.status();
            const clientRegistry = options.composition.services.platformRegistry;
            const established = ['AG-102', 'AG-103', 'AG-104', 'AG-105', 'AG-101'].filter(
              (agentId) => clientRegistry.getAgent(agentId) !== undefined,
            ).length;
            return {
              healthy: status.healthy,
              enabled: status.enabled,
              activeAgents: status.agents.active,
              establishedAgents: established,
              workflows: status.workflows,
              eventCount: status.eventCount,
            };
          },
          () => {
            const status = options.composition.services.freelancerAi.status();
            const platformRegistry = options.composition.services.platformRegistry;
            const established = ['AG-201', 'AG-202', 'AG-206', 'AG-207'].filter(
              (agentId) => platformRegistry.getAgent(agentId) !== undefined,
            ).length;
            return {
              healthy: status.healthy,
              enabled: status.enabled,
              activeAgents: status.agents.active,
              establishedAgents: established,
              workflows: status.workflows,
              eventCount: status.eventCount,
            };
          },
          () => {
            const status = options.composition.services.marketplaceAi.status();
            const platformRegistry = options.composition.services.platformRegistry;
            const established = ['AG-301', 'AG-302', 'AG-303', 'AG-304', 'AG-305', 'AG-306'].filter(
              (agentId) => platformRegistry.getAgent(agentId) !== undefined,
            ).length;
            return {
              healthy: status.healthy,
              enabled: status.enabled,
              activeAgents: status.agents.active,
              establishedAgents: established,
              workflows: status.workflows,
              eventCount: status.eventCount,
            };
          },
          () => {
            const status = options.composition.services.marketingAi.status();
            const platformRegistry = options.composition.services.platformRegistry;
            const established = ['AG-401', 'AG-402', 'AG-403', 'AG-404', 'AG-405'].filter(
              (agentId) => platformRegistry.getAgent(agentId) !== undefined,
            ).length;
            return {
              healthy: status.healthy,
              enabled: status.enabled,
              activeAgents: status.agents.active,
              establishedAgents: established,
              workflows: status.workflows,
              eventCount: status.eventCount,
            };
          },
          () => {
            const status = options.composition.services.adminAi.status();
            const platformRegistry = options.composition.services.platformRegistry;
            const established = ['AG-501', 'AG-502', 'AG-503', 'AG-504', 'AG-505'].filter(
              (agentId) => platformRegistry.getAgent(agentId) !== undefined,
            ).length;
            return {
              healthy: status.healthy,
              enabled: status.enabled,
              activeAgents: status.agents.active,
              establishedAgents: established,
              workflows: status.workflows,
              eventCount: status.eventCount,
            };
          },
          () => {
            const status = options.composition.services.aios.status();
            return {
              enabled: status.enabled,
              healthy: status.healthy,
              activeRequests: status.activeRequests,
              completedRequests: status.completedRequests,
              requestCounts: status.requestCounts,
              statusCounts: status.statusCounts,
            };
          },
        ));
  }

  /** Starts the server on the configured host/port. Returns the bound server. */
  start(port: number, host: string): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      this.server = server;
      server.once('error', reject);
      server.listen(port, host, () => {
        this.logger.info({ host, port }, 'runtime server listening');
        resolve(server);
      });
    });
  }

  /** Graceful shutdown: stop accepting, close storage handles. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.logger.info('runtime shutdown initiated');

    if (this.server !== undefined) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    try {
      await this.composition.storage.close();
      this.logger.info('storage handles closed');
    } catch (error) {
      this.logger.error({ error }, 'error during storage shutdown');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAtMs = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Sprint 34 — correlate every response and emit an access-log line with the
    // safe caller-supplied (or generated) request id. Never logs bodies.
    const requestId =
      sanitizeRequestId(String(req.headers['x-request-id'] ?? '')) ?? `aios-${randomUUID()}`;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      this.logger.info(
        {
          requestId,
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          durationMs: Date.now() - startedAtMs,
        },
        'http access',
      );
    });

    // Liveness: pure process signal, never probes dependencies.
    if (url.pathname === '/livez') {
      return this.sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
    }

    // Readiness: bounded probe of dependencies; fail-closed when degraded.
    if (url.pathname === '/readyz' || url.pathname === '/healthz' || url.pathname === '/health') {
      return this.handleReadiness(res);
    }

    // Sprint 35 F-4 — fail-closed auth gate. The resolved caller kind is the ONLY
    // source of actor identity and management authority downstream.
    const caller = this.resolveCaller(req);
    if (caller.kind === 'unauthorized') {
      this.logger.warn({ path: url.pathname, reason: caller.reason }, 'service auth rejected');
      return this.sendJson(res, 401, {
        status: 'error',
        error: 'unauthorized',
        path: url.pathname,
      });
    }

    if (req.method === 'POST' && url.pathname === '/runtime/request') {
      return this.handleRequest(req, res);
    }

    if (url.pathname.startsWith('/api/knowledge')) {
      return this.handleKnowledge(req, res, url, caller);
    }

    if (url.pathname.startsWith('/api/tools')) {
      return this.handleTools(req, res, url, caller);
    }

    if (url.pathname === '/api/llm/status') {
      return this.handleLlmStatus(res);
    }

    if (url.pathname === '/api/coordination/status') {
      return this.handleCoordinationStatus(res);
    }

    if (url.pathname === '/api/client-ai/status') {
      return this.handleClientAiStatus(res);
    }

    if (url.pathname === '/api/freelancer-ai/status') {
      return this.handleFreelancerAiStatus(res);
    }

    if (url.pathname === '/api/marketplace-ai/status') {
      return this.handleMarketplaceAiStatus(res);
    }

    if (url.pathname === '/api/marketing-ai/status') {
      return this.handleMarketingAiStatus(res);
    }

    if (url.pathname === '/api/admin-ai/status') {
      return this.handleAdminAiStatus(res);
    }

    if (url.pathname === '/api/ai/request') {
      return this.handleAiosRequest(req, res, caller);
    }

    if (url.pathname === '/api/ai/status') {
      return this.handleAiosStatus(req, res, url);
    }

    if (url.pathname === '/api/ai/cancel') {
      return this.handleAiosCancel(req, res);
    }

    return this.sendJson(res, 404, { status: 'not_found', path: url.pathname });
  }

  /**
   * Sprint 34 — readiness probe. Runs the configured health check under a hard
   * deadline so a hung storage/knowledge probe cannot stall infrastructure
   * orchestration, and fail-closes with 503 when any dependency is degraded or
   * timed out (previously every probe returned 200 regardless of state).
   */
  private async handleReadiness(res: ServerResponse): Promise<void> {
    const payload = await withDeadline(this.healthCheck(), READINESS_PROBE_TIMEOUT_MS);
    if (payload === undefined) {
      this.logger.warn({ timeoutMs: READINESS_PROBE_TIMEOUT_MS }, 'readiness probe timed out');
      return this.sendJson(res, 503, {
        status: 'degraded',
        error: 'readiness_probe_timeout',
        uptime: process.uptime(),
      });
    }
    const ready =
      payload.status === 'ok' &&
      !(payload.aiOperatingSystem.enabled && payload.aiOperatingSystem.healthy === false);
    return this.sendJson(res, ready ? 200 : 503, payload);
  }

  /**
   * LLM status endpoint (Sprint 17). Exposes configuration status, event-log
   * counts, and metric totals. Never exposes prompts, responses, or secrets.
   * Sprint 18 adds the agentic loop status block (limits + observability
   * totals only).
   */
  private async handleLlmStatus(res: ServerResponse): Promise<void> {
    const reasoning = this.composition.services.aiReasoning;
    const eventLog = this.composition.services.llmEventLog;
    const executorStatus = this.composition.services.executor.status();

    return this.sendJson(res, 200, {
      enabled: reasoning.isEnabled(),
      provider: reasoning.providerInfo().provider,
      model: reasoning.providerInfo().model,
      executor: executorStatus,
      agentic: this.agenticStatus(),
      events: {
        total: eventLog.count(),
        latest: eventLog.latest(10),
      },
      metrics: this.composition.services.llmMetrics.snapshot(),
    });
  }

  /**
   * Sprint 20 coordination status endpoint. Exposes coordinator health,
   * active/passed counts, and event-log metrics. Never exposes agent prompts,
   * results, or secrets.
   */
  private async handleCoordinationStatus(res: ServerResponse): Promise<void> {
    const coordination = this.composition.services.coordination;
    const eventLog = this.composition.services.coordinationEventLog;

    return this.sendJson(res, 200, {
      ...coordination.status(),
      events: {
        total: eventLog.count(),
        latest: eventLog.latest(10),
      },
    });
  }

  /**
   * Sprint 21 client AI team status endpoint. Exposes service health, team
   * agents/limits, workflows, and metrics. Never exposes prompts, briefs,
   * results, or secrets.
   */
  private async handleClientAiStatus(res: ServerResponse): Promise<void> {
    const clientAi = this.composition.services.clientAi;
    const status = clientAi.status();

    return this.sendJson(res, 200, {
      name: clientAi.name,
      version: clientAi.version,
      healthy: status.healthy,
      enabled: status.enabled,
      agents: status.agents,
      workflows: status.workflows,
      metrics: status.metrics,
      events: { total: status.eventCount },
    });
  }

  /**
   * Sprint 22 freelancer AI team status endpoint. Exposes service health,
   * team agents/limits, workflows, and metrics. Never exposes prompts, briefs,
   * results, or secrets.
   */
  private async handleFreelancerAiStatus(res: ServerResponse): Promise<void> {
    const freelancerAi = this.composition.services.freelancerAi;
    const status = freelancerAi.status();

    return this.sendJson(res, 200, {
      name: freelancerAi.name,
      version: freelancerAi.version,
      healthy: status.healthy,
      enabled: status.enabled,
      agents: status.agents,
      workflows: status.workflows,
      metrics: status.metrics,
      events: { total: status.eventCount },
    });
  }

  /**
   * Sprint 23 marketplace AI team status endpoint. Exposes service health,
   * team agents/limits, workflows, and metrics. Never exposes prompts, briefs,
   * results, or secrets.
   */
  private async handleMarketplaceAiStatus(res: ServerResponse): Promise<void> {
    const marketplaceAi = this.composition.services.marketplaceAi;
    const status = marketplaceAi.status();

    return this.sendJson(res, 200, {
      name: marketplaceAi.name,
      version: marketplaceAi.version,
      healthy: status.healthy,
      enabled: status.enabled,
      agents: status.agents,
      workflows: status.workflows,
      metrics: status.metrics,
      events: { total: status.eventCount },
    });
  }

  /**
   * Marketing AI status endpoint (Sprint 24). Exposes health, managed agents,
   * workflow ids and aggregated metrics/event totals. Never releases prompts,
   * secrets, or raw request payloads.
   */
  private async handleMarketingAiStatus(res: ServerResponse): Promise<void> {
    const marketingAi = this.composition.services.marketingAi;
    const status = marketingAi.status();

    return this.sendJson(res, 200, {
      name: marketingAi.name,
      version: marketingAi.version,
      healthy: status.healthy,
      enabled: status.enabled,
      agents: status.agents,
      workflows: status.workflows,
      metrics: status.metrics,
      events: { total: status.eventCount },
    });
  }

  /**
   * Admin AI status endpoint (Sprint 25). Exposes health, managed agents,
   * workflow ids and aggregated metrics/event totals. Never releases prompts,
   * secrets, raw request payloads, or PII.
   */
  private async handleAdminAiStatus(res: ServerResponse): Promise<void> {
    const adminAi = this.composition.services.adminAi;
    const status = adminAi.status();

    return this.sendJson(res, 200, {
      name: adminAi.name,
      version: adminAi.version,
      healthy: status.healthy,
      enabled: status.enabled,
      agents: status.agents,
      workflows: status.workflows,
      metrics: status.metrics,
      events: { total: status.eventCount },
    });
  }

  /** Body shape accepted at the Sprint 26 AIOS request endpoint. */
  private async handleAiosRequest(
    req: IncomingMessage,
    res: ServerResponse,
    caller: AuthenticatedCaller,
  ): Promise<void> {
    const body = await this.readJson<AiosRequestInput>(req);
    if (body === undefined) {
      return this.sendJson(res, 400, { status: 'error', error: 'invalid_json' });
    }
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return this.sendJson(res, 400, { status: 'error', error: 'text_required' });
    }

    // Sprint 33 — a default request id must never collide across concurrent
    // requests; callers may still supply their own (bounded length).
    const requestId = body.requestId ? sanitizeRequestId(body.requestId) : `aios-${randomUUID()}`;
    const traceId = body.traceId ?? `trace-${requestId}`;
    const role = toUserRole(body.role as UserRole | undefined) ?? UserRoleValue.Freelancer;

    const request: AiosRequest = {
      requestId,
      traceId,
      input: { text: body.text, structured: body.structured as AiosRequest['input']['structured'] },
      // Sprint 35 F-2/F-6 — the idempotency keyspace is bound to the identity
      // established by the service boundary, never to the body `actorId`.
      principalId: caller.actorId,
      actor: {
        actorId: body.actorId ?? 'aios-gateway',
        role,
        group: body.actorGroup,
        namespaces: body.namespaces ?? [],
        adminScopes: body.adminScopes,
        securityClearance: body.securityClearance,
      },
      options: {
        idempotencyKey: body.idempotencyKey,
        timeoutMs: body.timeoutMs,
        metadata: body.metadata,
      },
    };

    try {
      const response = await this.composition.services.aios.request(request);
      return this.sendJson(res, 200, response);
    } catch (error) {
      this.logger.error({ error, requestId }, 'aios request failed');
      return this.sendAiosError(res, error, requestId);
    }
  }

  /** AIOS status endpoint (Sprint 26). Overall or per-request snapshot. */
  private async handleAiosStatus(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const requestId = url.searchParams.get('requestId') ?? undefined;
    const status = this.composition.services.aios.status(requestId);
    return this.sendJson(res, 200, status);
  }

  /** AIOS cancel endpoint (Sprint 26). Cooperative abort of an in-flight request. */
  private async handleAiosCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson<{ readonly requestId?: string }>(req);
    const requestId = body?.requestId;
    if (requestId === undefined || requestId.length === 0) {
      return this.sendJson(res, 400, { status: 'error', error: 'requestId_required' });
    }
    this.composition.services.aios.cancel(requestId);
    return this.sendJson(res, 200, { status: 'cancelled', requestId });
  }

  private sendAiosError(res: ServerResponse, error: unknown, requestId: string): void {
    const aios = toAiosError(error);
    const payload = {
      status: 'error',
      requestId,
      error: aios.code,
      message: aios.message,
      stage: aios.stage,
      details: aios.details,
    };
    return this.sendJson(res, aios.status, payload);
  }

  private agenticStatus(): {
    enabled: boolean;
    limits: Readonly<Record<string, number>>;
    events: { total: number };
    metrics: {
      totals: Readonly<{
        operations: number;
        turns: number;
        toolCalls: number;
        toolCallSuccesses: number;
        toolCallFailures: number;
        toolCallRejections: number;
        reasoningCalls: number;
        cancellations: number;
        timeouts: number;
        limitReached: number;
        failures: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }>;
      totalDurationMs: number;
    };
  } {
    const loop = this.composition.services.agenticLoop;
    const eventLog = this.composition.services.agenticEventLog;
    const metrics = this.composition.services.agenticMetrics.snapshot();
    return {
      enabled: loop.isEnabled(),
      limits: agenticLimitSummary(this.composition.env.agentic),
      events: { total: eventLog.count() },
      metrics,
    };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson<RuntimeRequestBody>(req);
    if (body === undefined) {
      return this.sendJson(res, 400, { status: 'error', error: 'invalid_json' });
    }
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return this.sendJson(res, 400, { status: 'error', error: 'text_required' });
    }

    const requestId = body.requestId ?? `req-${Date.now()}`;
    const traceId = body.traceId ?? `trace-${requestId}`;

    // Phase 5: bind the request's memory actor so the executor can provision AG-002 context.
    if (body.actor !== undefined && (body.actor.namespaces?.length ?? 0) > 0) {
      const binding: RequestActorBinding = {
        requestId,
        traceId,
        actorGroup: toActorGroup(body.actor.group) ?? MemoryActorGroupValue.Client,
        actorId: body.actor.id,
        actorRole: body.actor.role,
        namespaces: body.actor.namespaces ?? [],
        organizationId: body.actor.organizationId,
        workspaceId: body.actor.workspaceId,
        projectIds: body.actor.projectIds,
        securityClearance: body.actor.securityClearance as RequestActorBinding['securityClearance'],
      };
      this.composition.services.requestActors.register(binding);
    }

    try {
      const request: OrchestrationRequest = {
        text: body.text,
        role: toUserRole(body.role) ?? UserRoleValue.Freelancer,
        requestId,
        traceId,
      };
      const response = await this.composition.services.orchestrator.execute(request);
      return this.sendJson(res, 200, response);
    } catch (error) {
      this.logger.error({ error, requestId }, 'orchestration request failed');
      return this.sendJson(res, 500, {
        status: 'error',
        error: 'orchestration_failed',
        requestId,
      });
    } finally {
      this.composition.services.requestActors.unregister(requestId);
    }
  }

  /**
   * AG-003 knowledge API (Phase 9). Typed JSON endpoints:
   *   POST /api/knowledge            -> create a knowledge document
   *   GET  /api/knowledge?query=&ns= -> search authorizable documents
   *   GET  /api/knowledge/:id        -> fetch a document by id
   */
  private async handleKnowledge(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    caller: AuthenticatedCaller,
  ): Promise<void> {
    const km = this.composition.services.knowledgeManager;
    const pathParts = url.pathname.split('/').filter(Boolean); // ['api','knowledge',...]
    const id = pathParts.length > 2 ? pathParts[2] : undefined;

    // Sprint 35 F-1 — the actor group and actor id are taken from the trusted
    // caller resolved by the auth gate, never from the request. `?group=` and
    // `?actorId=` are no longer able to widen access.
    const actorGroup = knowledgeActorGroupForCaller(caller);
    const actorId = caller.actorId;

    try {
      if (req.method === 'POST' && id === undefined) {
        return await this.handleKnowledgeCreate(req, res, km, actorGroup, actorId);
      }
      if (req.method === 'GET' && id === undefined) {
        const queryParam = url.searchParams.get('query') ?? '';
        const namespace = url.searchParams.get('ns') ?? 'default';
        // Sprint 33 — clamp the caller-controlled limit at the boundary; the
        // knowledge service enforces the same ceiling for all callers.
        const rawMax = Number(url.searchParams.get('max') ?? '10');
        const maxResults = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 10;
        const result = await km.search({
          query: queryParam,
          namespace,
          actorGroup,
          actorId,
          namespaces: [namespace],
          maxResults,
        });
        return this.sendJson(res, 200, {
          total: result.total,
          documents: result.documents,
        });
      }
      if (req.method === 'GET' && id !== undefined) {
        const doc = await km.getDocument(id, actorGroup, actorId);
        if (doc === undefined) {
          return this.sendJson(res, 404, { status: 'not_found', id });
        }
        return this.sendJson(res, 200, doc);
      }
      return this.sendJson(res, 405, { status: 'method_not_allowed' });
    } catch (error) {
      // Sprint 35 F-1/F-4 — a namespace-scoped denial is an authorization
      // failure, not a generic 400. Logged without prompt/knowledge content.
      const denied = error instanceof KnowledgeAccessDeniedError;
      this.logger.warn(
        { path: url.pathname, actorId, denied, code: (error as { code?: string })?.code },
        denied ? 'knowledge access denied' : 'knowledge request failed',
      );
      if (denied) {
        return this.sendJson(res, 403, { status: 'error', error: 'forbidden', id });
      }
      this.logger.error({ error, path: url.pathname }, 'knowledge request failed');
      return this.sendJson(res, 400, { status: 'error', error: 'knowledge_request_failed' });
    }
  }

  private async handleKnowledgeCreate(
    req: IncomingMessage,
    res: ServerResponse,
    km: ProductionComposition['services']['knowledgeManager'],
    actorGroup: KnowledgeActorGroup,
    actorId: string,
  ): Promise<void> {
    const body = await this.readJson<KnowledgeCreateBody>(req);
    if (body === undefined) {
      return this.sendJson(res, 400, { status: 'error', error: 'invalid_json' });
    }
    if (typeof body.title !== 'string' || typeof body.content !== 'string') {
      return this.sendJson(res, 400, { status: 'error', error: 'title_and_content_required' });
    }
    const contentType: KnowledgeContentType =
      body.contentType === KnowledgeContentType.Markdown
        ? KnowledgeContentType.Markdown
        : body.contentType === KnowledgeContentType.Json
          ? KnowledgeContentType.Json
          : body.contentType === KnowledgeContentType.Html
            ? KnowledgeContentType.Html
            : KnowledgeContentType.PlainText;
    const securityLevel: KnowledgeSecurityLevel =
      body.securityLevel === KnowledgeSecurityLevel.Confidential
        ? KnowledgeSecurityLevel.Confidential
        : KnowledgeSecurityLevel.Internal;
    const sourceType: KnowledgeSourceType =
      body.sourceType === KnowledgeSourceType.Markdown
        ? KnowledgeSourceType.Markdown
        : body.sourceType === KnowledgeSourceType.Document
          ? KnowledgeSourceType.Document
          : body.sourceType === KnowledgeSourceType.System
            ? KnowledgeSourceType.System
            : KnowledgeSourceType.ManualText;

    const doc = await km.createDocument({
      title: body.title,
      content: body.content,
      contentType,
      namespace: body.namespace ?? 'default',
      securityLevel,
      source: {
        sourceType,
        reference: body.reference,
      },
      metadata:
        body.metadata !== undefined
          ? (body.metadata as Record<string, string | number | boolean | null>)
          : {},
      // Sprint 35 F-1 — identity comes from the trusted caller, not the body.
      actorGroup,
      actorId,
    });
    return this.sendJson(res, 201, doc);
  }

  /**
   * AG-004 tools API. Production-safe typed JSON endpoints:
   *   GET  /api/tools                 -> list tools (authorized, safe metadata)
   *   GET  /api/tools/:name           -> fetch a tool definition by name
   *   POST /api/tools/:name/execute   -> execute a registered tool
   *   POST /api/tools/:name/enable    -> enable (management, ToolManager/Admin)
   *   POST /api/tools/:name/disable   -> disable (management, ToolManager/Admin)
   *
   * Execution never leaks internal details or stack traces.
   */
  private async handleTools(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    caller: AuthenticatedCaller,
  ): Promise<void> {
    const tm = this.composition.services.toolManager;
    if (!tm.enabled) {
      return this.sendJson(res, 403, { status: 'error', error: 'tools_disabled' });
    }

    const pathParts = url.pathname.split('/').filter(Boolean); // ['api','tools',name?,action?]
    const name = pathParts.length > 2 ? pathParts[2] : undefined;
    const action = pathParts.length > 3 ? pathParts[3] : undefined;

    const namespace = url.searchParams.get('ns') ?? 'default';
    const isManagement = action === 'enable' || action === 'disable';

    // Sprint 35 F-3 — enable/disable is a management capability. It is authorized
    // by the dedicated admin credential resolved by the auth gate, NOT by a
    // caller-supplied `?group=`. Previously `?group=ADMIN` on the query string
    // was sufficient to disable any registered tool in the deployment.
    if (isManagement && caller.kind !== 'admin') {
      this.logger.warn(
        { path: url.pathname, callerKind: caller.kind, actorId: caller.actorId },
        'tool management denied',
      );
      return this.sendJson(res, 403, { status: 'error', error: 'forbidden' });
    }

    // Sprint 35 F-3 — read/execute actor group is likewise derived from the
    // trusted caller; `?group=` is no longer authoritative.
    const actorGroup = isManagement ? ToolActorGroup.Admin : toolActorGroupForCaller(caller);

    const actor: ToolActor = {
      group: actorGroup,
      id: caller.actorId,
      namespaces: [namespace],
      securityClearance: ToolSecurityLevel.Internal,
    };

    try {
      if (req.method === 'GET' && name === undefined && action === undefined) {
        const definitions = tm.list(actor, namespace);
        return this.sendJson(res, 200, {
          total: definitions.length,
          tools: definitions.map((d) => ({
            id: d.id,
            name: d.name,
            description: d.description,
            version: d.version,
            category: d.category,
            enabled: d.enabled,
            securityLevel: d.securityLevel,
            executionPolicy: {
              timeoutMs: d.executionPolicy.timeoutMs,
              maxInputBytes: d.executionPolicy.maxInputBytes,
              maxOutputBytes: d.executionPolicy.maxOutputBytes,
            },
          })),
        });
      }
      if (req.method === 'GET' && name !== undefined && action === undefined) {
        const definition = tm.get(name, actor, namespace);
        if (definition === undefined) {
          return this.sendJson(res, 404, { status: 'not_found', name });
        }
        return this.sendJson(res, 200, definition);
      }
      if (req.method === 'POST' && name !== undefined && action === 'execute') {
        return await this.handleToolExecute(req, res, tm, name, actor, namespace);
      }
      if (
        req.method === 'POST' &&
        name !== undefined &&
        (action === 'enable' || action === 'disable')
      ) {
        const managed =
          action === 'enable'
            ? await tm.enable(name, actor, namespace)
            : await tm.disable(name, actor, namespace);
        return this.sendJson(res, 200, { name: managed.name, enabled: managed.enabled });
      }
      return this.sendJson(res, 405, { status: 'method_not_allowed' });
    } catch (error) {
      this.logger.error({ error, path: url.pathname }, 'tool request failed');
      return this.sendJson(res, 400, { status: 'error', error: 'tool_request_failed' });
    }
  }

  private async handleToolExecute(
    req: IncomingMessage,
    res: ServerResponse,
    tm: ProductionComposition['services']['toolManager'],
    name: string,
    actor: ToolActor,
    namespace: string,
  ): Promise<void> {
    const body = await this.readJson<ToolExecuteBody>(req);
    if (body === undefined) {
      return this.sendJson(res, 400, { status: 'error', error: 'invalid_json' });
    }

    const result = await tm.execute(name, body.input ?? {}, {
      actor,
      namespace: body.namespace ?? namespace,
      requestId: body.requestId,
      traceId: body.traceId,
      correlationId: body.traceId,
      timeoutMs: body.timeoutMs,
    });

    const status =
      result.status === ToolResultStatus.Success
        ? 200
        : result.status === ToolResultStatus.NotFound
          ? 404
          : result.status === ToolResultStatus.AuthorizationFailed
            ? 403
            : result.status === ToolResultStatus.ValidationFailed
              ? 400
              : 422;

    return this.sendJson(res, status, {
      toolId: result.toolId,
      toolName: result.toolName,
      toolVersion: result.toolVersion,
      executionId: result.executionId,
      status: result.status,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      output: result.output,
      durationMs: result.durationMs,
      attempts: result.attempts,
    });
  }

  private async readJson<T>(req: IncomingMessage): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_000_000) {
          resolve(undefined);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          if (chunks.length === 0) {
            resolve(undefined);
            return;
          }
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
        } catch {
          resolve(undefined);
        }
      });
      req.on('error', () => resolve(undefined));
    });
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  /**
   * Server-to-server auth gate (Sprint 29 boundary; Sprint 35 F-3/F-4).
   *
   * Returns the *trusted* kind of caller, resolved from the presented
   * credential — never from request fields. Liveness probes are handled before
   * this gate.
   *
   * Sprint 35 F-4: this is fail-closed by default. With no configured service
   * token the business API is denied rather than silently open; local
   * development must opt in via `AIOS_ALLOW_UNAUTHENTICATED=true`, which is
   * ignored in production.
   *
   * Sprint 35 F-3: management authorization comes from the dedicated admin
   * credential. A caller holding only the service token can never assert an
   * administrative actor group.
   */
  private resolveCaller(req: IncomingMessage): CallerResolution {
    const provided = req.headers['x-aios-service-token'];
    const adminProvided = req.headers['x-aios-admin-token'];

    if (this.serviceToken === '') {
      // F-4: fail-closed unless an explicit, non-production opt-in is present.
      if (this.allowUnauthenticated) {
        return { kind: 'anonymous', actorId: ANONYMOUS_ACTOR_ID };
      }
      return { kind: 'unauthorized', reason: 'service_token_not_configured' };
    }

    if (!constantTimeEquals(provided, this.serviceToken)) {
      return { kind: 'unauthorized', reason: 'invalid_service_token' };
    }

    // F-3: administrative authority requires the separate admin credential and
    // is never inferred from caller-supplied actor/group fields.
    if (this.adminToken !== '' && constantTimeEquals(adminProvided, this.adminToken)) {
      return { kind: 'admin', actorId: `${SERVICE_ACTOR_ID}:admin` };
    }
    return { kind: 'service', actorId: SERVICE_ACTOR_ID };
  }
}

/** Convenience: builds a {@link ProductionRuntime} over a composition. */
export function createProductionRuntime(options: ProductionRuntimeOptions): ProductionRuntime {
  return new ProductionRuntime(options);
}

/**
 * Sprint 35 F-3/F-4 — the trusted caller kinds resolved by the auth gate.
 *
 * `kind` is derived exclusively from the presented credential. Handlers must
 * derive actor identity and management authority from it and must never read
 * them from the request body, query string, or headers.
 */
export type TrustedCallerKind = 'admin' | 'service' | 'anonymous';

/** A caller whose identity was established by the service boundary. */
export interface AuthenticatedCaller {
  readonly kind: TrustedCallerKind;
  readonly actorId: string;
}

/** Outcome of the auth gate: an established caller, or a refusal with a reason. */
export type CallerResolution =
  AuthenticatedCaller | { readonly kind: 'unauthorized'; readonly reason: string };

/** Sprint 35 F-4 — actor id used for an explicitly unauthenticated dev caller. */
const ANONYMOUS_ACTOR_ID = 'anonymous-dev';

/** Sprint 35 F-4 — server-side actor id for a service-token caller. */
const SERVICE_ACTOR_ID = 'aios-service';

/**
 * Constant-time string comparison for credentials. Length is compared first
 * (unavoidable for a fixed-length HMAC-style compare) but the content
 * comparison never short-circuits, so no timing signal distinguishes a
 * near-correct token from a wrong one. Never logs either value.
 */
function constantTimeEquals(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Sprint 34 — resolves a promise within a hard deadline. Returns `undefined`
 * when the deadline expires first; the in-flight probe is abandoned and its
 * handlers are detached so it cannot keep the process alive.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    }, ms);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(undefined);
        }
      },
    );
  });
}

/** Maps a raw string to a {@link MemoryActorGroup}, or undefined when unknown. */
function toActorGroup(value: MemoryActorGroup | undefined): MemoryActorGroup | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Object.values(MemoryActorGroupValue).includes(value as MemoryActorGroupValue)) {
    return value;
  }
  return undefined;
}

/** Maps a raw string to a {@link UserRole}, or undefined when unknown. */
function toUserRole(value: UserRole | undefined): UserRole | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Object.values(UserRoleValue).includes(value as UserRoleValue)) {
    return value;
  }
  return undefined;
}

/**
 * Sprint 33 — bounds a caller-supplied request id so a client cannot use it
 * to overwrite unrelated request-state entries (e.g. another request's
 * completed result or memory binding). Falls back to a fresh UUID when the
 * value is not a tame identifier.
 */
function sanitizeRequestId(value: string): string {
  if (/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(value)) {
    return value;
  }
  return `aios-${randomUUID()}`;
}

/**
 * Sprint 35 F-1 — maps a *trusted* caller to its knowledge actor group.
 *
 * This is the only place a knowledge actor group may be produced from the HTTP
 * boundary. An administrative credential maps to {@link KnowledgeActorGroup.Admin};
 * every other authenticated caller maps to {@link KnowledgeActorGroup.KnowledgeManager}
 * (read/create/update-version, but not namespace-independent admin) and is still
 * bound to its persisted namespace membership inside AG-003.
 */
function knowledgeActorGroupForCaller(caller: AuthenticatedCaller): KnowledgeActorGroup {
  return caller.kind === 'admin' ? KnowledgeActorGroup.Admin : KnowledgeActorGroup.KnowledgeManager;
}

/**
 * Sprint 35 F-3 — maps a *trusted* caller to its tool actor group. Never derived
 * from request fields. Service callers get read+execute; administrative callers
 * additionally get management.
 */
function toolActorGroupForCaller(caller: AuthenticatedCaller): ToolActorGroup {
  return caller.kind === 'admin' ? ToolActorGroup.Admin : ToolActorGroup.Orchestrator;
}

export type { OrchestrationRequest, OrchestratorResponse };
