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
}

/** Default health payload; never surfaces secrets or connection strings. */
export async function defaultHealth(
  checkStorage: ProductionComposition['health']['probeStorage'],
): Promise<HealthPayload> {
  const storageHealth = await checkStorage();
  return {
    status: storageHealth.healthy ? 'ok' : 'degraded',
    uptime: process.uptime(),
    storage: { healthy: storageHealth.healthy },
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
      options.healthCheck ?? (() => defaultHealth(options.composition.health.probeStorage));
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

export type { OrchestrationRequest, OrchestratorResponse };
