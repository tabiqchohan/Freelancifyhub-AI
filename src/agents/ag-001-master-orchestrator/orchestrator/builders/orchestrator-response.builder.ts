import { AggregationStatus } from '../../aggregation/index.js';
import type { AggregatedResponse } from '../../aggregation/index.js';
import type { ExecutionResult } from '../../execution/index.js';
import type { IntentResult } from '../../intent/index.js';
import type { ExecutionPlan } from '../../planning/index.js';
import type { RouteDecision, RouteEscalation } from '../../routing/index.js';
import type { IsoTimestamp, RequestId, TraceId } from '../../types/index.js';
import { nowIso } from '../../utils/ids.js';
import type { OrchestratorResponse, OrchestratorStage } from '../types/index.js';

/** Inputs needed to assemble the final orchestration response. */
export interface BuildOrchestratorResponseInput {
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly startedAt: IsoTimestamp;
  readonly stage: OrchestratorStage;
  readonly intent: IntentResult;
  readonly route: RouteDecision;
  readonly plan?: ExecutionPlan;
  readonly execution?: ExecutionResult;
  readonly aggregated?: AggregatedResponse;
  /** Explicit status override for paths without an aggregation result. */
  readonly status?: AggregationStatus;
  readonly escalation?: RouteEscalation;
}

/**
 * Assembles the immutable final {@link OrchestratorResponse}. The status comes
 * from the aggregation result whenever present so terminal execution states
 * are never overwritten (prompt §13); fail-closed paths use an explicit
 * override.
 */
export function buildOrchestratorResponse(
  input: BuildOrchestratorResponseInput,
): OrchestratorResponse {
  const completedAt = nowIso();
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(input.startedAt));
  const status = input.status ?? input.aggregated?.status ?? AggregationStatus.Failed;

  return {
    requestId: input.requestId,
    traceId: input.traceId,
    status,
    stage: input.stage,
    intent: input.intent,
    route: input.route,
    plan: input.plan,
    execution: input.execution,
    aggregated: input.aggregated,
    escalation: input.escalation,
    startedAt: input.startedAt,
    completedAt,
    durationMs,
  };
}
