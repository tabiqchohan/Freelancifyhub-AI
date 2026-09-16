/**
 * Sprint 26 — AIOS pipeline (the unified request execution path).
 *
 * Phase chain for every inbound request:
 *   VALIDATE → CREATE_REQUEST_CONTEXT → DETECT_INTENT → BUILD_CONTEXT →
 *   AUTHORIZE → ROUTE → PLAN → EXECUTE → AGGREGATE → SAFETY_CHECK →
 *   PERSIST_EVENTS → UPDATE_METRICS → FINALIZE_RESPONSE
 *
 * Each phase is owned explicitly and emits a typed lifecycle event. The
 * pipeline throws {@link AiosError} on any fail-closed outcome; the gateway
 * turns those into bounded responses.
 */

import type { IntentClassifier } from '../agents/ag-001-master-orchestrator/intent/index.js';
import { AggregationStatus } from '../agents/ag-001-master-orchestrator/aggregation/index.js';
import { MemoryActorGroup } from '../agents/ag-002-memory-manager/index.js';
import type { RequestActorBinding, RequestActorRegistry } from '../app/request-actors.js';
import type { AiosConfig } from './config.js';
import { AiosError, AiosErrorCode, toAiosError } from './errors.js';
import { createExactAiosPlan } from './execution-context.js';
import { createExecutionContext } from './execution-context.js';
import type { ExecutionCatcher } from './execution-result.js';
import type { AiosEventLog } from './events.js';
import type { AiosMetrics } from './metrics.js';
import type { AiosPolicy } from './policy.js';
import type { RequestContext } from './request-context.js';
import { createRequestContext } from './request-context.js';
import { composeAiosResponse } from './response.js';
import { assertNoSecrets, redactSecrets } from './security.js';
import type { AiosService } from './service.js';
import {
  AiosStage,
  type AiosActor,
  type AiosInput,
  type AiosRequestOptions,
  type AiosRequestStatus,
  type AiosResponse,
} from './types.js';

export interface AiosPipelineOptions {
  readonly config: AiosConfig;
  readonly classifier: IntentClassifier;
  readonly requestActors: RequestActorRegistry;
  readonly policy: AiosPolicy;
  readonly service: AiosService;
  readonly eventLog: AiosEventLog;
  readonly metrics: AiosMetrics;
}

export interface AiosPipelineInput {
  readonly requestId: string;
  readonly traceId: string;
  readonly actor: AiosActor;
  readonly input: AiosInput;
  readonly options?: AiosRequestOptions;
}

/** The AIOS pipeline. Owns the phase chain; never throws tail errors. */
export class AiosPipeline {
  private readonly options: AiosPipelineOptions;

  constructor(options: AiosPipelineOptions) {
    this.options = options;
  }

  async execute(input: AiosPipelineInput): Promise<AiosResponse> {
    const log = this.options.eventLog;
    const metrics = this.options.metrics;
    const startedAtMs = Date.now();
    const reached: AiosStage[] = [];
    this.stage(log, input.requestId, input.traceId, AiosStage.Validate, reached);

    const secretScanEnabled = this.options.config.AIOS_SECRET_SCAN_ENABLED;
    assertNoSecrets(input.input.text, secretScanEnabled);

    let ctx: RequestContext;
    let execution: ExecutionCatcher;

    try {
      ctx = createRequestContext({
        requestId: input.requestId,
        traceId: input.traceId,
        actor: input.actor,
        input: input.input,
        classifier: this.options.classifier,
        timeoutMs: this.options.config.AIOS_REQUEST_TIMEOUT_MS,
        idempotencyKey: input.options?.idempotencyKey,
        metadata: input.options?.metadata ?? {},
      });
      this.stage(log, input.requestId, input.traceId, AiosStage.CreateRequestContext, reached, {
        intent: ctx.route.intentId,
      });
      this.stage(log, input.requestId, input.traceId, AiosStage.DetectIntent, reached, {
        confidence: ctx.intent.confidence,
        intent: ctx.route.intentId,
      });

      this.provisionMemoryContext(ctx);
      this.stage(log, input.requestId, input.traceId, AiosStage.BuildContext, reached, {
        namespaces: ctx.actor.namespaces,
      });

      const decision = this.options.policy.evaluate(ctx);
      if (!decision.allowed) {
        throw new AiosError(
          decision.reason ?? AiosErrorCode.UnauthorizedScope,
          'The AIOS request was not authorized',
          { requestId: ctx.requestId, stage: AiosStage.Authorize },
        );
      }
      this.stage(log, input.requestId, input.traceId, AiosStage.Authorize, reached, {
        allowed: true,
      });

      this.stage(log, input.requestId, input.traceId, AiosStage.Route, reached, {
        target: ctx.target.kind,
        intentId: ctx.route.intentId,
      });

      const plan = createExactAiosPlan(ctx);
      this.stage(log, input.requestId, input.traceId, AiosStage.Plan, reached, {
        plan,
      });

      const exec = createExecutionContext({
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        target: ctx.target,
        intentId: ctx.route.intentId,
        timeoutMs: this.timeoutFor(ctx, input.options?.timeoutMs),
        plan,
        metadata: ctx.metadata,
      });
      metrics.recordPoint(`intent.${ctx.route.intentId}`);
      metrics.recordPoint(`target.${ctx.target.kind}`);
      this.stage(log, input.requestId, input.traceId, AiosStage.Execute, reached, {
        target: ctx.target.kind,
      });

      execution = await this.options.service.dispatch(ctx, exec);

      this.stage(log, input.requestId, input.traceId, AiosStage.Aggregate, reached, {
        status: execution.status,
      });

      execution = this.safetyCheck(ctx, execution, secretScanEnabled);
      this.stage(log, input.requestId, input.traceId, AiosStage.SafetyCheck, reached, {
        status: execution.status,
      });

      this.persistEvents(ctx, execution, reached);
      this.stage(log, input.requestId, input.traceId, AiosStage.PersistEvents, reached);

      metrics.recordStatus(execution.status);
      metrics.recordDuration(
        `duration.${execution.target.kind}`,
        Math.max(0, execution.completedAtMs - execution.startedAtMs),
      );
      this.stage(log, input.requestId, input.traceId, AiosStage.UpdateMetrics, reached, {
        status: execution.status,
      });
    } catch (error) {
      const aios = toAiosError(error);
      metrics.recordStatus(statusForCode(aios.code));
      metrics.recordPoint(`errors.${aios.code}`);
      log.emitFor(
        input.requestId,
        input.traceId,
        aios.code === AiosErrorCode.Cancelled ? 'request.cancelled' : 'request.failed',
        AiosStage.Failed,
        { errorCode: aios.code, stage: aios.stage ?? reached[reached.length - 1] },
      );
      throw aios;
    }

    const response = composeAiosResponse(ctx, execution, reached, { secretScanEnabled });
    this.stage(log, input.requestId, input.traceId, AiosStage.FinalizeResponse, reached, {
      status: response.status,
    });
    metrics.recordDuration('duration.all', Math.max(0, Date.now() - startedAtMs));
    return response;
  }

  private timeoutFor(ctx: RequestContext, requested: number | undefined): number {
    const parsed = requested;
    if (parsed !== undefined && Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.floor(parsed), ctx.timeoutMs);
    }
    return ctx.timeoutMs;
  }

  private provisionMemoryContext(ctx: RequestContext): void {
    this.options.requestActors.register({
      requestId: `exec_${ctx.requestId}`,
      traceId: ctx.traceId,
      actorGroup: resolveActorGroup(ctx),
      actorId: ctx.actor.actorId,
      actorRole: ctx.actor.role,
      namespaces: ctx.actor.namespaces,
      securityClearance: ctx.actor.securityClearance as RequestActorBinding['securityClearance'],
    });
  }

  private safetyCheck(
    _ctx: RequestContext,
    execution: ExecutionCatcher,
    enabled: boolean,
  ): ExecutionCatcher {
    if (!enabled) {
      return execution;
    }
    const safe = redactSecrets(execution.responseText, true);
    return { ...execution, responseText: safe };
  }

  private persistEvents(
    ctx: RequestContext,
    execution: ExecutionCatcher,
    reached: readonly AiosStage[],
  ): void {
    const log = this.options.eventLog;
    log.emitFor(ctx.requestId, ctx.traceId, eventForStatus(execution.status), AiosStage.Completed, {
      intent: ctx.route.intentId,
      target: ctx.target.kind,
      status: execution.status,
      stages: [...reached],
      agents: execution.agents,
    });
    if (ctx.metadata.aiosProbe === true) {
      log.injectProbe(ctx.requestId, ctx.traceId);
    }
  }

  private stage(
    log: AiosEventLog,
    requestId: string,
    traceId: string,
    stage: AiosStage,
    reached: AiosStage[],
    metadata?: Readonly<Record<string, unknown>>,
  ): void {
    reached.push(stage);
    log.emitFor(requestId, traceId, 'stage.completed', stage, metadata);
  }
}

/** Maps a team/memory actor group value, falling back to role defaults. */
function resolveActorGroup(ctx: RequestContext): MemoryActorGroup {
  const raw = ctx.actor.group;
  if (raw !== undefined) {
    const match = Object.values(MemoryActorGroup).find((v) => v === raw);
    if (match !== undefined) {
      return match;
    }
  }
  if (ctx.target.kind === 'admin' || ctx.actor.role === 'Admin' || ctx.actor.role === 'System') {
    return MemoryActorGroup.Admin;
  }
  if (ctx.actor.role === 'Freelancer') {
    return MemoryActorGroup.Freelancer;
  }
  return MemoryActorGroup.Client;
}

function eventForStatus(status: AiosRequestStatus): string {
  switch (status) {
    case 'CANCELLED':
      return 'request.cancelled';
    case 'TIMED_OUT':
      return 'request.timed_out';
    case 'FAILED':
      return 'request.failed';
    default:
      return 'request.succeeded';
  }
}

function statusForCode(code: AiosErrorCode): AiosRequestStatus {
  switch (code) {
    case AiosErrorCode.Cancelled:
      return AggregationStatus.Cancelled;
    case AiosErrorCode.DeadlineExceeded:
      return AggregationStatus.TimedOut;
    case AiosErrorCode.SecretDetected:
    case AiosErrorCode.InvalidInput:
    case AiosErrorCode.PayloadTooLarge:
    case AiosErrorCode.UnknownIntent:
    case AiosErrorCode.UnauthorizedScope:
    case AiosErrorCode.ToolNotAllowed:
    case AiosErrorCode.AgentNotReady:
    case AiosErrorCode.RouteUnavailable:
    case AiosErrorCode.ExecutionFailed:
    case AiosErrorCode.Internal:
    default:
      return AggregationStatus.Failed;
  }
}
