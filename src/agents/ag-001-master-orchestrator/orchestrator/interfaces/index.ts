import type { AggregationInput, AggregatedResponse } from '../../aggregation/index.js';
import type { ContextBuildRequest, ContextBuildResult } from '../../context/index.js';
import type { ExecutionEngineContract, ExecutionResult } from '../../execution/index.js';
import type { IntentClassifier } from '../../intent/index.js';
import type { ExecutionPlanBuilderContract } from '../../planning/index.js';
import type { RoutingEngine as RoutingEngineContract } from '../../routing/interfaces/index.js';
import type { RequestId } from '../../types/index.js';
import type { OrchestrationRequest, OrchestratorResponse } from '../types/index.js';

export type { IntentClassifier, ExecutionEngineContract, ExecutionPlanBuilderContract };
export type { RoutingEngineContract };

/**
 * Minimal contract satisfied by the Context Builder (Sprint 3). Uses the
 * existing build request/result contracts so no logic is duplicated.
 */
export interface ContextBuilderContract {
  build(request: ContextBuildRequest): ContextBuildResult;
}

/** Minimal contract satisfied by the Shared Aggregation Service (Sprint 7). */
export interface AggregationServiceContract {
  aggregate(input: AggregationInput): AggregatedResponse;
}

/**
 * Cancellation-capable execution engine. Extends the existing
 * {@link ExecutionEngineContract} with the cancellation method the concrete
 * execution engine already exposes (prompt §14).
 */
export interface CancellableExecutionEngine extends ExecutionEngineContract {
  cancel(executionId: string, reason?: string): void;
}

/** Contract satisfied by the Master Orchestrator Service. */
export interface MasterOrchestratorServiceContract {
  readonly name: string;
  readonly version: string;
  execute(input: OrchestrationRequest): Promise<OrchestratorResponse>;
  cancel(requestId: RequestId, reason?: string): void;
}

export type { ExecutionResult };
