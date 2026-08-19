import type { IntentId } from '../../intent/index.js';
import type { IsoTimestamp, RequestId, TraceId } from '../../types/index.js';
import type { OrchestratorStage } from '../types/index.js';

/** Orchestration-level lifecycle events (spec §16, prompt §17). */
export enum OrchestratorEventType {
  OrchestrationStarted = 'ORCHESTRATION_STARTED',
  IntentDetected = 'INTENT_DETECTED',
  ContextBuilt = 'CONTEXT_BUILT',
  RoutingCompleted = 'ROUTING_COMPLETED',
  PlanCreated = 'PLAN_CREATED',
  ExecutionStarted = 'EXECUTION_STARTED',
  ExecutionCompleted = 'EXECUTION_COMPLETED',
  AggregationCompleted = 'AGGREGATION_COMPLETED',
  OrchestrationCompleted = 'ORCHESTRATION_COMPLETED',
  OrchestrationFailed = 'ORCHESTRATION_FAILED',
  OrchestrationCancelled = 'ORCHESTRATION_CANCELLED',
}

/** A single, correlated orchestration event. */
export interface OrchestratorEvent {
  readonly type: OrchestratorEventType;
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly occurredAt: IsoTimestamp;
  readonly stage?: OrchestratorStage;
  readonly executionId?: string;
  readonly planId?: string;
  readonly intentId?: IntentId;
  readonly status?: string;
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Emits correlated orchestration events without coupling to a sink. */
export interface OrchestratorEventEmitter {
  readonly name: string;
  emit(event: OrchestratorEvent): void;
  on(handler: (event: OrchestratorEvent) => void): () => void;
}

/** Deterministic in-memory event emitter used by tests and local callers. */
export class InMemoryOrchestratorEventEmitter implements OrchestratorEventEmitter {
  readonly name = 'in-memory-orchestrator-events';

  private readonly handlers = new Set<(event: OrchestratorEvent) => void>();
  private readonly recorded: OrchestratorEvent[] = [];

  emit(event: OrchestratorEvent): void {
    this.recorded.push(event);
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  on(handler: (event: OrchestratorEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  list(): readonly OrchestratorEvent[] {
    return [...this.recorded];
  }

  clear(): void {
    this.recorded.length = 0;
  }
}
