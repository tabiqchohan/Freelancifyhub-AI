import type { Logger } from 'pino';

import {
  AggregationStatus,
  SharedAggregationService,
  type AggregatedResponse,
} from '../../aggregation/index.js';
import { RequestContextBuilder } from '../../builders/request-context.builder.js';
import type { OrchestratorConfig } from '../../config/schema.js';
import { orchestratorConfig } from '../../config/index.js';
import { ContextBuilder, type ContextSnapshot } from '../../context/index.js';
import { ExecutionEngine, type ExecutionResult } from '../../execution/index.js';
import { validateExecutionPlan } from '../../execution/validators/index.js';
import { RuleBasedIntentClassifier, type IntentResult } from '../../intent/index.js';
import { ExecutionPlanBuilder, type ExecutionPlan } from '../../planning/index.js';
import { RoutingEngine, RoutingStatus, type RouteDecision } from '../../routing/index.js';
import { nowIso } from '../../utils/ids.js';
import { createOrchestratorLogger } from '../../utils/logger.js';
import { validateAgentRequest } from '../../validators/agent.validator.js';
import { ConfigurationError } from '../../errors/index.js';
import { buildOrchestratorResponse } from '../builders/orchestrator-response.builder.js';
import { toOrchestrationError } from '../errors/index.js';
import type {
  AggregationServiceContract,
  CancellableExecutionEngine,
  ContextBuilderContract,
  ExecutionPlanBuilderContract,
  IntentClassifier,
  MasterOrchestratorServiceContract,
  RoutingEngineContract,
} from '../interfaces/index.js';
import {
  OrchestratorStage,
  type OrchestrationRequest,
  type OrchestratorResponse,
} from '../types/index.js';
import { normalizeOrchestrationRequest } from '../validators/index.js';
import {
  InMemoryOrchestratorEventEmitter,
  OrchestratorEventType,
  type OrchestratorEvent,
  type OrchestratorEventEmitter,
} from './events.js';

/** Required engine dependencies injected into the service (prompt §2). */
export interface MasterOrchestratorServiceDependencies {
  readonly intentClassifier: IntentClassifier;
  readonly contextBuilder: ContextBuilderContract;
  readonly routingEngine: RoutingEngineContract;
  readonly planBuilder: ExecutionPlanBuilderContract;
  readonly executionEngine: CancellableExecutionEngine;
  readonly aggregationService: AggregationServiceContract;
}

/** Options for constructing the Master Orchestrator Service. */
export interface MasterOrchestratorServiceOptions extends MasterOrchestratorServiceDependencies {
  readonly config?: OrchestratorConfig;
  readonly logger?: Logger;
  readonly events?: OrchestratorEventEmitter;
}

/**
 * The Master Orchestrator (AG-001, prompt §1). Coordinates the existing
 * engines end-to-end: validation → intent → context → routing → planning →
 * execution → aggregation → response. It is a coordinator only: every engine
 * stays responsible for its own domain and is injected (never constructed
 * internally). Deterministic and transport-independent.
 */
export class MasterOrchestratorService implements MasterOrchestratorServiceContract {
  readonly name = 'master-orchestrator-service';
  readonly version = '1.0.0';

  private readonly config: OrchestratorConfig;
  private readonly logger: Logger;
  private readonly events: OrchestratorEventEmitter;

  private readonly intentClassifier: IntentClassifier;
  private readonly contextBuilder: ContextBuilderContract;
  private readonly routingEngine: RoutingEngineContract;
  private readonly planBuilder: ExecutionPlanBuilderContract;
  private readonly executionEngine: CancellableExecutionEngine;
  private readonly aggregationService: AggregationServiceContract;

  private readonly activeExecutions = new Map<string, string>();
  private readonly cancellations = new Map<string, boolean>();
  private readonly traceIds = new Map<string, string>();

  constructor(options: MasterOrchestratorServiceOptions) {
    this.assertDependencies(options);
    this.config = options.config ?? orchestratorConfig;
    this.logger = options.logger ?? createOrchestratorLogger('orchestrator');
    this.events = options.events ?? new InMemoryOrchestratorEventEmitter();

    this.intentClassifier = options.intentClassifier;
    this.contextBuilder = options.contextBuilder;
    this.routingEngine = options.routingEngine;
    this.planBuilder = options.planBuilder;
    this.executionEngine = options.executionEngine;
    this.aggregationService = options.aggregationService;
  }

  /**
   * Cancels a request. Idempotent: marks the request cancelled, propagates to
   * the execution engine when the execution is active, and always emits a
   * correlated cancellation event (prompt §14).
   */
  cancel(requestId: string, reason = 'cancelled by caller'): void {
    this.cancellations.set(requestId, true);

    const executionId = this.activeExecutions.get(requestId);
    if (executionId !== undefined) {
      this.executionEngine.cancel(executionId, reason);
    }

    this.events.emit({
      type: OrchestratorEventType.OrchestrationCancelled,
      requestId,
      traceId: this.traceIds.get(requestId) ?? requestId,
      occurredAt: nowIso(),
      stage: OrchestratorStage.Execution,
      errorCode: 'CANCELLED',
      metadata: { reason },
    });
  }

  /** Runs the full orchestration lifecycle for a single request. */
  async execute(input: OrchestrationRequest): Promise<OrchestratorResponse> {
    const startedAt = nowIso();
    const normalized = normalizeOrchestrationRequest(input);
    const { requestId, traceId } = normalized;
    this.traceIds.set(requestId, traceId);

    const requestContextBuilder = new RequestContextBuilder()
      .withTraceId(traceId)
      .withRequestId(requestId)
      .withReceivedAt(startedAt);
    if (normalized.origin !== undefined) {
      requestContextBuilder.withOrigin(normalized.origin);
    }
    const requestContext = requestContextBuilder.build();

    const request = validateAgentRequest({
      agentId: 'AG-001',
      type: 'orchestrate',
      payload: { text: normalized.text },
      context: requestContext,
    });

    this.emit(OrchestratorEventType.OrchestrationStarted, {
      requestId,
      traceId,
      stage: OrchestratorStage.Validation,
      metadata: {
        textLength: normalized.text.length,
        orchestrator: this.config.ORCHESTRATOR_NAME,
      },
    });

    let intent: IntentResult;
    try {
      intent = this.intentClassifier.classify(normalized.text, {
        role: normalized.role,
        requestId,
      });
    } catch (error) {
      this.fail(requestId, traceId, OrchestratorStage.IntentDetection, error);
    }
    this.emit(OrchestratorEventType.IntentDetected, {
      requestId,
      traceId,
      stage: OrchestratorStage.IntentDetection,
      intentId: intent.primary.intent.id,
      metadata: {
        confidence: intent.confidence,
        fallback: intent.fallback,
        fallbackReason: intent.fallbackReason,
      },
    });

    let context: ContextSnapshot;
    try {
      const built = this.contextBuilder.build({
        requestId,
        traceId,
        items: normalized.contextItems ?? [],
        budget: normalized.budget,
      });
      context = built.snapshot;
    } catch (error) {
      this.fail(requestId, traceId, OrchestratorStage.ContextBuilding, error);
    }
    this.emit(OrchestratorEventType.ContextBuilt, {
      requestId,
      traceId,
      stage: OrchestratorStage.ContextBuilding,
      metadata: {
        itemCount: context.statistics.totalItems,
        estimatedTokens: context.estimatedTokens,
      },
    });

    let route: RouteDecision;
    try {
      route = this.routingEngine.route({
        requestId,
        traceId,
        request,
        intent,
        context,
        role: normalized.role,
        constraints: normalized.routingConstraints,
      });
    } catch (error) {
      this.fail(requestId, traceId, OrchestratorStage.Routing, error);
    }
    this.emit(OrchestratorEventType.RoutingCompleted, {
      requestId,
      traceId,
      stage: OrchestratorStage.Routing,
      intentId: route.intentId,
      status: route.status,
      metadata: {
        strategy: route.strategy,
        executionMode: route.executionMode,
        candidateCount: route.candidates.length,
        selectedAgent: route.selectedAgent?.agent.agentId,
      },
    });

    if (route.status === RoutingStatus.Escalated) {
      return this.failClosed(startedAt, requestId, traceId, intent, route);
    }

    let plan: ExecutionPlan;
    try {
      plan = this.planBuilder.build({
        requestId,
        traceId,
        request,
        intent,
        context,
        route,
        role: normalized.role,
        constraints: normalized.planningConstraints,
      });
    } catch (error) {
      this.fail(requestId, traceId, OrchestratorStage.Planning, error);
    }

    try {
      validateExecutionPlan(plan);
    } catch (error) {
      this.fail(requestId, traceId, OrchestratorStage.Planning, error);
    }
    this.emit(OrchestratorEventType.PlanCreated, {
      requestId,
      traceId,
      stage: OrchestratorStage.Planning,
      planId: plan.planId,
      metadata: {
        mode: plan.mode,
        stepCount: plan.steps.length,
        dependencyCount: plan.dependencies.length,
      },
    });

    if (this.cancellations.get(requestId) === true) {
      this.logger.warn({ requestId, traceId }, 'orchestration cancelled before execution');
      return buildOrchestratorResponse({
        requestId,
        traceId,
        startedAt,
        stage: OrchestratorStage.Execution,
        intent,
        route,
        plan,
        status: AggregationStatus.Cancelled,
      });
    }

    const executionId = `exec_${requestId}`;
    this.activeExecutions.set(requestId, executionId);
    this.emit(OrchestratorEventType.ExecutionStarted, {
      requestId,
      traceId,
      stage: OrchestratorStage.Execution,
      executionId,
      planId: plan.planId,
    });

    let execution: ExecutionResult;
    try {
      execution = await this.executionEngine.execute({
        executionId,
        plan,
        requestId,
        traceId,
        inputs: { 'request.input': normalized.text },
      });
    } catch (error) {
      this.activeExecutions.delete(requestId);
      this.fail(requestId, traceId, OrchestratorStage.Execution, error);
    }
    this.activeExecutions.delete(requestId);
    this.emit(OrchestratorEventType.ExecutionCompleted, {
      requestId,
      traceId,
      stage: OrchestratorStage.Execution,
      executionId,
      planId: plan.planId,
      status: execution.state,
      metadata: { durationMs: execution.durationMs, stepCount: execution.stepResults.length },
    });

    let aggregated: AggregatedResponse;
    try {
      aggregated = this.aggregationService.aggregate({
        executionId,
        plan,
        results: [execution],
        intent,
        route,
        context,
      });
    } catch (error) {
      this.fail(requestId, traceId, OrchestratorStage.Aggregation, error);
    }
    this.emit(OrchestratorEventType.AggregationCompleted, {
      requestId,
      traceId,
      stage: OrchestratorStage.Aggregation,
      executionId,
      planId: plan.planId,
      status: aggregated.status,
      metadata: { resultCount: aggregated.statistics.totalSteps },
    });

    const response = buildOrchestratorResponse({
      requestId,
      traceId,
      startedAt,
      stage: OrchestratorStage.Response,
      intent,
      route,
      plan,
      execution,
      aggregated,
    });

    this.emit(OrchestratorEventType.OrchestrationCompleted, {
      requestId,
      traceId,
      stage: OrchestratorStage.Response,
      executionId,
      planId: plan.planId,
      status: response.status,
      metadata: { durationMs: response.durationMs },
    });

    this.logger.info(
      {
        requestId,
        traceId,
        intent: intent.primary.intent.id,
        routeStatus: route.status,
        planId: plan.planId,
        executionState: execution.state,
        responseStatus: response.status,
        durationMs: response.durationMs,
      },
      'orchestration completed',
    );

    return response;
  }

  /** Emits a correlated event with standard fields filled in. */
  private emit(
    type: OrchestratorEventType,
    event: Omit<OrchestratorEvent, 'type' | 'occurredAt'>,
  ): void {
    this.events.emit({ type, occurredAt: nowIso(), ...event });
  }

  /** Fails closed at construction when a required engine is missing. */
  private assertDependencies(options: MasterOrchestratorServiceOptions): void {
    const missing = Object.entries({
      intentClassifier: options.intentClassifier,
      contextBuilder: options.contextBuilder,
      routingEngine: options.routingEngine,
      planBuilder: options.planBuilder,
      executionEngine: options.executionEngine,
      aggregationService: options.aggregationService,
    })
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new ConfigurationError(
        `MasterOrchestratorService is missing required dependencies: ${missing.join(', ')}`,
        { details: { missing } },
      );
    }
  }

  /** Converts a stage failure into a typed error and emits a failed event. */
  private fail(
    requestId: string,
    traceId: string,
    stage: OrchestratorStage,
    error: unknown,
  ): never {
    const wrapped = toOrchestrationError(stage, error, { requestId, traceId });
    this.emit(OrchestratorEventType.OrchestrationFailed, {
      requestId,
      traceId,
      stage,
      errorCode: wrapped.code,
    });
    this.logger.error(
      { requestId, traceId, stage, code: wrapped.code, retryable: wrapped.retryable },
      'orchestration stage failed',
    );
    throw wrapped;
  }

  /** Builds a fail-closed response when the route escalates (prompt §5). */
  private failClosed(
    startedAt: string,
    requestId: string,
    traceId: string,
    intent: IntentResult,
    route: RouteDecision,
  ): OrchestratorResponse {
    const reason = route.escalation?.reason ?? 'ROUTE_ESCALATED';
    this.emit(OrchestratorEventType.OrchestrationFailed, {
      requestId,
      traceId,
      stage: OrchestratorStage.Routing,
      intentId: route.intentId,
      status: route.status,
      errorCode: reason,
      metadata: { escalation: route.escalation?.message },
    });
    this.logger.warn(
      {
        requestId,
        traceId,
        intent: intent.primary.intent.id,
        reason,
        message: route.escalation?.message,
      },
      'orchestration failed closed on escalation',
    );
    return buildOrchestratorResponse({
      requestId,
      traceId,
      startedAt,
      stage: OrchestratorStage.Routing,
      intent,
      route,
      status: AggregationStatus.Failed,
      escalation: route.escalation,
    });
  }
}

/**
 * Composition root that wires the real engines into the service. Callers may
 * override any dependency for tests or alternative runtimes (prompt §2).
 */
export function createMasterOrchestratorService(
  options: Omit<MasterOrchestratorServiceOptions, keyof MasterOrchestratorServiceDependencies> &
    Partial<MasterOrchestratorServiceDependencies> = {},
): MasterOrchestratorService {
  return new MasterOrchestratorService({
    config: options.config,
    logger: options.logger,
    events: options.events,
    intentClassifier: options.intentClassifier ?? new RuleBasedIntentClassifier(),
    contextBuilder: options.contextBuilder ?? new ContextBuilder(),
    routingEngine: options.routingEngine ?? new RoutingEngine(),
    planBuilder: options.planBuilder ?? new ExecutionPlanBuilder(),
    executionEngine: options.executionEngine ?? new ExecutionEngine(),
    aggregationService: options.aggregationService ?? new SharedAggregationService(),
  });
}
