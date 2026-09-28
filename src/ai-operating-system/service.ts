/**
 * Sprint 26 — AIOS execution service (EXECUTE phase).
 *
 * Dispatches a validated AIOS request to the owning tail:
 *
 *   - client / freelancer / marketplace / marketing / admin: the AI team
 *     service selected by the AIOS route (derived from AG-001 registry data),
 *     invoked through its validated request contract with a cooperative
 *     cancellation signal and bounded limits;
 *   - orchestrator: AG-001's {@link MasterOrchestratorService} for
 *     platform-level intents (help/knowledge/system/unknown fallbacks).
 *
 * The AIOS never builds its own agent routing or duplication of team logic.
 */

import type { MasterOrchestratorService } from '../agents/ag-001-master-orchestrator/index.js';
import { AggregationStatus } from '../agents/ag-001-master-orchestrator/aggregation/index.js';
import type { UserRole } from '../agents/ag-001-master-orchestrator/intent/index.js';
import type { ClientAIService, ClientRequest } from '../agents/client-ai-team/index.js';
import type { FreelancerAIService, FreelancerRequest } from '../agents/freelancer-ai-team/index.js';
import type {
  MarketplaceAIService,
  MarketplaceRequest,
} from '../agents/marketplace-ai-team/index.js';
import type { MarketingAIService, MarketingRequest } from '../agents/marketing-ai-team/index.js';
import type { AdminAIService, AdminRequest } from '../agents/admin-ai-team/index.js';
import type { AiosConfig } from './config.js';
import { AiosError, AiosErrorCode } from './errors.js';
import { KNOB_DELAY_MS, type ExecutionContext } from './execution-context.js';
import { normalizeExecutionResult, type ExecutionCatcher } from './execution-result.js';
import type { RequestContext } from './request-context.js';
import type { AiosExecutionTarget } from './types.js';

export interface AiosServiceDeps {
  readonly config: AiosConfig;
  readonly orchestrator: MasterOrchestratorService;
  readonly clientAi: ClientAIService;
  readonly freelancerAi: FreelancerAIService;
  readonly marketplaceAi: MarketplaceAIService;
  readonly marketingAi: MarketingAIService;
  readonly adminAi: AdminAIService;
  readonly log?: (entry: { readonly requestId: string; readonly message: string }) => void;
}

/** Outcome of a dispatched tail (bounded; the AIOS never throws tail errors). */
interface TailOutcome {
  readonly status: 'result' | 'timeout' | 'error';
  readonly result?: ExecutionCatcher;
  readonly error?: unknown;
}

type TeamHandle = (request: never) => Promise<{
  readonly status?: string;
  readonly response?: string;
}>;

const TEAM_TARGETS: ReadonlySet<AiosExecutionTarget['kind']> = new Set([
  'client',
  'freelancer',
  'marketplace',
  'marketing',
  'admin',
]);

/** Upper bound on completed-request results retained for status/cancel lookup.
 * Insertion-order eviction keeps the map bounded under sustained traffic. */
const MAX_COMPLETED_REQUESTS = 1_000;

/**
 * The AIOS execution service. Runs one validated request on its tail and
 * keeps an active-execution registry for cancellation/status.
 */
export class AiosService {
  readonly name = 'aios-service';
  readonly version = '1.0.0';

  private readonly deps: AiosServiceDeps;
  private readonly active = new Map<string, ExecutionContext>();
  private readonly completedRequests = new Map<string, ExecutionCatcher>();

  constructor(deps: AiosServiceDeps) {
    this.deps = deps;
  }

  activeCount(): number {
    return this.active.size;
  }

  isActive(requestId: string): boolean {
    return this.active.has(requestId);
  }

  lastResult(requestId: string): ExecutionCatcher | undefined {
    return this.completedRequests.get(requestId);
  }

  cancel(requestId: string): void {
    const exec = this.active.get(requestId);
    if (exec === undefined) {
      return;
    }
    exec.controller.abort();
    if (exec.target.kind === 'orchestrator') {
      this.deps.orchestrator.cancel(requestId, 'cancelled by AIOS gateway');
    }
  }

  /** Runs the tail for a request and normalizes the outcome. */
  async dispatch(ctx: RequestContext, exec: ExecutionContext): Promise<ExecutionCatcher> {
    // Sprint 34 — reject a second dispatch while the same requestId is still
    // in flight (previously both runs would proceed and one outcome would
    // silently overwrite the other's active entry).
    if (this.active.has(ctx.requestId)) {
      throw new AiosError(
        AiosErrorCode.IdempotencyConflict,
        'A request with this requestId is already in flight',
        { requestId: ctx.requestId, details: { inFlight: true } },
      );
    }
    this.active.set(ctx.requestId, exec);
    try {
      const outcome = await this.runTail(ctx, exec);
      if (outcome.status === 'timeout') {
        const startedAtMs = exec.startedAtMs;
        const catcher: ExecutionCatcher = {
          target: exec.target,
          status: AggregationStatus.TimedOut,
          responseText: 'The AIOS request exceeded its configured deadline.',
          agents: [],
          startedAtMs,
          completedAtMs: Date.now(),
          error: { code: AiosErrorCode.DeadlineExceeded, message: 'Deadline exceeded' },
        };
        this.recordResult(ctx.requestId, catcher);
        return catcher;
      }
      if (outcome.status === 'error') {
        // Preserve the original tail failure instead of silently producing a
        // success-shaped undefined result (Sprint 33 correctness fix).
        const catcher = this.failedCatcher(exec, 'The AIOS execution tail failed', outcome.error);
        this.recordResult(ctx.requestId, catcher);
        return catcher;
      }
      const result = outcome.result ?? this.failedCatcher(exec, 'No tail result was produced');
      this.recordResult(ctx.requestId, result);
      return result;
    } finally {
      this.active.delete(ctx.requestId);
    }
  }

  /** Bounded retention for completed requests (Sprint 33). Keeps at most
   * {@link MAX_COMPLETED_REQUESTS} results so the map cannot grow without
   * bound under sustained traffic. */
  private recordResult(requestId: string, catcher: ExecutionCatcher): void {
    if (this.completedRequests.size >= MAX_COMPLETED_REQUESTS) {
      const oldest = this.completedRequests.keys().next().value;
      if (oldest !== undefined) {
        this.completedRequests.delete(oldest as string);
      }
    }
    this.completedRequests.set(requestId, catcher);
  }

  private async runTail(ctx: RequestContext, exec: ExecutionContext): Promise<TailOutcome> {
    if (exec.target.kind === 'orchestrator') {
      return this.runOrchestrator(ctx, exec);
    }
    return this.runTeam(ctx, exec);
  }

  private async runOrchestrator(ctx: RequestContext, exec: ExecutionContext): Promise<TailOutcome> {
    const run = Promise.resolve(
      this.deps.orchestrator.execute({
        text: ctx.input.text,
        role: ctx.actor.role as UserRole,
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        origin: 'ai-operating-system',
      }),
    );
    const outcome = await raceDeadline(run, exec);
    if (outcome.status === 'timeout') {
      this.deps.orchestrator.cancel(ctx.requestId, 'deadline exceeded by AIOS gateway');
      return { status: 'timeout' };
    }
    if (outcome.status === 'error') {
      return { status: 'error', error: outcome.error };
    }
    return {
      status: 'result',
      result: normalizeExecutionResult(exec.target, outcome.value, exec.startedAtMs),
    };
  }

  private async runTeam(ctx: RequestContext, exec: ExecutionContext): Promise<TailOutcome> {
    const kind = exec.target.kind;
    const handle = this.teamHandle(kind);
    const run = Promise.resolve(handle(this.buildTeamRequest(ctx, exec)));
    const outcome = await raceDeadline(run, exec);
    if (outcome.status === 'timeout') {
      exec.controller.abort();
      return { status: 'timeout' };
    }
    if (outcome.status === 'error') {
      return { status: 'error', error: outcome.error };
    }
    const raw = outcome.value as {
      readonly status?: string;
      readonly response?: string;
      readonly structuredData?: Readonly<Record<string, unknown>>;
      readonly agents?: readonly string[];
      readonly confidence?: number;
      readonly coordinationId?: string;
      readonly coordinationStatus?: string;
      readonly memoryReferences?: readonly string[];
      readonly knowledgeReferences?: readonly string[];
    };
    return {
      status: 'result',
      result: normalizeExecutionResult(exec.target, raw as never, exec.startedAtMs),
    };
  }

  private teamHandle(kind: AiosExecutionTarget['kind']): TeamHandle {
    switch (kind) {
      case 'client':
        return this.deps.clientAi.handle.bind(this.deps.clientAi) as TeamHandle;
      case 'freelancer':
        return this.deps.freelancerAi.handle.bind(this.deps.freelancerAi) as TeamHandle;
      case 'marketplace':
        return this.deps.marketplaceAi.handle.bind(this.deps.marketplaceAi) as TeamHandle;
      case 'marketing':
        return this.deps.marketingAi.handle.bind(this.deps.marketingAi) as TeamHandle;
      case 'admin':
        return this.deps.adminAi.handle.bind(this.deps.adminAi) as TeamHandle;
      default:
        throw new AiosError(AiosErrorCode.RouteUnavailable, `Unsupported AIOS tail: ${kind}`);
    }
  }

  private buildTeamRequest(ctx: RequestContext, exec: ExecutionContext): never {
    const common = {
      correlationId: ctx.traceId,
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      intent: ctx.route.intentId,
      limits: {
        timeoutMs: knobNumber(ctx.metadata, 'aios.taskTimeoutMs', ctx.timeoutMs),
        globalTimeoutMs: knobNumber(
          ctx.metadata,
          'aios.globalTimeoutMs',
          Math.max(30_000, ctx.timeoutMs * 20),
        ),
      },
      cancellation: exec.cancellation,
      metadata: this.metadataWithKnobs(ctx),
    };
    switch (exec.target.kind) {
      case 'client': {
        const request: ClientRequest = {
          clientRequestId: `${ctx.requestId}:client`,
          ...common,
          input: { brief: ctx.input.text, ...(ctx.input.structured ?? {}) },
          actor: {
            actorId: ctx.actor.actorId,
            namespaces: ctx.actor.namespaces,
            role: ctx.actor.role,
            organizationId: opt(ctx.input.structured, 'organizationId'),
            workspaceId: opt(ctx.input.structured, 'workspaceId'),
            securityClearance: ctx.actor.securityClearance,
          },
        };
        return request as never;
      }
      case 'freelancer': {
        const request: FreelancerRequest = {
          freelancerRequestId: `${ctx.requestId}:freelancer`,
          ...common,
          input: { ...(ctx.input.structured ?? {}) },
          actor: {
            actorId: ctx.actor.actorId,
            namespaces: ctx.actor.namespaces,
            role: ctx.actor.role,
            securityClearance: ctx.actor.securityClearance,
          },
        };
        return request as never;
      }
      case 'marketplace': {
        const request: MarketplaceRequest = {
          marketplaceRequestId: `${ctx.requestId}:marketplace`,
          ...common,
          input: { ...(ctx.input.structured ?? {}) },
          actor: {
            actorId: ctx.actor.actorId,
            namespaces: ctx.actor.namespaces,
            role: ctx.actor.role,
            securityClearance: ctx.actor.securityClearance,
          },
        };
        return request as never;
      }
      case 'marketing': {
        const request: MarketingRequest = {
          marketingRequestId: `${ctx.requestId}:marketing`,
          ...common,
          input: { ...(ctx.input.structured ?? {}) },
          actor: {
            actorId: ctx.actor.actorId,
            namespaces: ctx.actor.namespaces,
            role: ctx.actor.role,
            securityClearance: ctx.actor.securityClearance,
          },
        };
        return request as never;
      }
      case 'admin': {
        const structured = ctx.input.structured ?? {};
        const action =
          typeof structured.action === 'object' &&
          structured.action !== null &&
          !Array.isArray(structured.action)
            ? structured.action
            : { kind: ctx.route.intentId, reason: ctx.input.text };
        const request: AdminRequest = {
          adminRequestId: `${ctx.requestId}:admin`,
          ...common,
          input: { ...structured, action },
          actor: {
            actorId: ctx.actor.actorId,
            namespaces: ctx.actor.namespaces,
            role: ctx.actor.role,
            adminScopes: ctx.actor.adminScopes ?? [],
            securityClearance: ctx.actor.securityClearance,
          },
        };
        return request as never;
      }
      default:
        throw new AiosError(
          AiosErrorCode.RouteUnavailable,
          `Unsupported AIOS tail: ${exec.target.kind}`,
        );
    }
  }

  private metadataWithKnobs(ctx: RequestContext): Readonly<Record<string, unknown>> {
    const team = ctx.target.kind;
    const delay = knobNumber(ctx.metadata, KNOB_DELAY_MS, undefined);
    const out: Record<string, unknown> = { ...ctx.metadata };
    if (delay !== undefined && TEAM_TARGETS.has(ctx.target.kind)) {
      out[`${team}.delayMs`] = delay;
    }
    return out;
  }

  private failedCatcher(
    exec: ExecutionContext,
    message: string,
    cause?: unknown,
  ): ExecutionCatcher {
    const code = cause instanceof AiosError ? cause.code : AiosErrorCode.ExecutionFailed;
    const detailMessage =
      cause instanceof Error && cause.message.length > 0 ? cause.message : message;
    return {
      target: exec.target,
      status: AggregationStatus.Failed,
      responseText: message,
      agents: [],
      startedAtMs: exec.startedAtMs,
      completedAtMs: Date.now(),
      error: { code, message: detailMessage },
    };
  }
}

/** Reads a finite number knob from uncontrolled metadata (never exposed). */
function knobNumber(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number | undefined,
): number | undefined {
  const value = metadata[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  return fallback;
}

/** Reads an optional primitive string from structured input. */
function opt(
  structured: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = structured?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Races the tail run against the execution deadline. Preserves tail failures
 * (instead of swallowing them) so dispatch can produce an accurate failed
 * catcher (Sprint 33 fix). */
async function raceDeadline<T>(
  run: Promise<T>,
  exec: ExecutionContext,
): Promise<
  | { readonly status: 'result'; readonly value: T }
  | { readonly status: 'timeout' }
  | { readonly status: 'error'; readonly error: unknown }
> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (
      r:
        | { readonly status: 'result'; readonly value: T }
        | { readonly status: 'timeout' }
        | { readonly status: 'error'; readonly error: unknown },
    ): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    const remaining = Math.max(1, exec.deadlineAt - Date.now());
    const timer = setTimeout(() => {
      if (!settled) {
        settle({ status: 'timeout' });
      }
    }, remaining);
    run.then(
      (value) => settle({ status: 'result', value }),
      (error) => settle({ status: 'error', error }),
    );
  });
}
