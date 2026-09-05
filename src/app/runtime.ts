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
  ToolActorGroup as ToolActorGroupValue,
  ToolResultStatus,
  ToolSecurityLevel,
  type ToolActor,
  type ToolActorGroup,
} from '../agents/ag-004-tool-manager/index.js';

import type { ProductionComposition } from './composition-root.js';
import type { RequestActorBinding } from './request-actors.js';

/** Options for constructing the production HTTP runtime (Phase 7). */
export interface ProductionRuntimeOptions {
  readonly composition: ProductionComposition;
  readonly logger: Logger;
  /** Health/readiness payload builder; omit for default (no storage probe). */
  readonly healthCheck?: () => Promise<HealthPayload>;
}

/** The health/readiness payload exposed at `/healthz` (Phase 8). */
export interface HealthPayload {
  readonly status: 'ok' | 'degraded';
  readonly uptime: number;
  readonly storage: { healthy: boolean };
  readonly knowledge: { healthy: boolean };
  readonly tools: { healthy: boolean };
}

/** Default health payload; never surfaces secrets or connection strings. */
export async function defaultHealth(
  checkStorage: ProductionComposition['health']['probeStorage'],
  checkKnowledge?: ProductionComposition['health']['probeKnowledgeStorage'],
  checkTools?: ProductionComposition['health']['probeToolStorage'],
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
  private server: Server | undefined;
  private shuttingDown = false;

  constructor(options: ProductionRuntimeOptions) {
    this.composition = options.composition;
    this.logger = options.logger;
    this.healthCheck =
      options.healthCheck ??
      (() =>
        defaultHealth(
          options.composition.health.probeStorage,
          options.composition.health.probeKnowledgeStorage,
          options.composition.health.probeToolStorage,
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
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz' || url.pathname === '/health') {
      return this.sendJson(res, 200, await this.healthCheck());
    }

    if (req.method === 'POST' && url.pathname === '/runtime/request') {
      return this.handleRequest(req, res);
    }

    if (url.pathname.startsWith('/api/knowledge')) {
      return this.handleKnowledge(req, res, url);
    }

    if (url.pathname.startsWith('/api/tools')) {
      return this.handleTools(req, res, url);
    }

    return this.sendJson(res, 404, { status: 'not_found', path: url.pathname });
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
  ): Promise<void> {
    const km = this.composition.services.knowledgeManager;
    const pathParts = url.pathname.split('/').filter(Boolean); // ['api','knowledge',...]
    const id = pathParts.length > 2 ? pathParts[2] : undefined;

    try {
      if (req.method === 'POST' && id === undefined) {
        return await this.handleKnowledgeCreate(req, res, km);
      }
      if (req.method === 'GET' && id === undefined) {
        const queryParam = url.searchParams.get('query') ?? '';
        const namespace = url.searchParams.get('ns') ?? 'default';
        const maxResults = Number(url.searchParams.get('max') ?? '10') || 10;
        const actorGroup =
          toKnowledgeActorGroup(url.searchParams.get('group') ?? undefined) ??
          KnowledgeActorGroup.KnowledgeManager;
        const actorId = url.searchParams.get('actorId') ?? 'runtime';
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
        const actorGroup =
          toKnowledgeActorGroup(url.searchParams.get('group') ?? undefined) ??
          KnowledgeActorGroup.KnowledgeManager;
        const actorId = url.searchParams.get('actorId') ?? 'runtime';
        const doc = await km.getDocument(id, actorGroup, actorId);
        if (doc === undefined) {
          return this.sendJson(res, 404, { status: 'not_found', id });
        }
        return this.sendJson(res, 200, doc);
      }
      return this.sendJson(res, 405, { status: 'method_not_allowed' });
    } catch (error) {
      this.logger.error({ error, path: url.pathname }, 'knowledge request failed');
      return this.sendJson(res, 400, { status: 'error', error: 'knowledge_request_failed' });
    }
  }

  private async handleKnowledgeCreate(
    req: IncomingMessage,
    res: ServerResponse,
    km: ProductionComposition['services']['knowledgeManager'],
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
      actorGroup: toKnowledgeActorGroup(body.actorGroup) ?? KnowledgeActorGroup.KnowledgeManager,
      actorId: body.actorId ?? 'runtime',
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
  private async handleTools(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const tm = this.composition.services.toolManager;
    if (!tm.enabled) {
      return this.sendJson(res, 403, { status: 'error', error: 'tools_disabled' });
    }

    const pathParts = url.pathname.split('/').filter(Boolean); // ['api','tools',name?,action?]
    const name = pathParts.length > 2 ? pathParts[2] : undefined;
    const action = pathParts.length > 3 ? pathParts[3] : undefined;

    const namespace = url.searchParams.get('ns') ?? 'default';
    const actorGroup = toToolActorGroup(url.searchParams.get('group') ?? undefined);
    const actorId = url.searchParams.get('actorId') ?? 'runtime';

    if (actorGroup === undefined) {
      return this.sendJson(res, 400, { status: 'error', error: 'invalid_actor_group' });
    }

    const actor: ToolActor = {
      group: actorGroup,
      id: actorId,
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
}

/** Convenience: builds a {@link ProductionRuntime} over a composition. */
export function createProductionRuntime(options: ProductionRuntimeOptions): ProductionRuntime {
  return new ProductionRuntime(options);
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

/** Maps a raw string to a {@link KnowledgeActorGroup}, or undefined when unknown. */
function toKnowledgeActorGroup(value: string | undefined): KnowledgeActorGroup | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Object.values(KnowledgeActorGroup).includes(value as KnowledgeActorGroup)) {
    return value as KnowledgeActorGroup;
  }
  return undefined;
}

/** Maps a raw string to a {@link ToolActorGroup}, or undefined when unknown. */
function toToolActorGroup(value: string | undefined): ToolActorGroup | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Object.values(ToolActorGroupValue).includes(value as ToolActorGroupValue)) {
    return value as ToolActorGroupValue;
  }
  return undefined;
}

export type { OrchestrationRequest, OrchestratorResponse };
