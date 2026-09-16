/**
 * Sprint 26 — AIOS execution result (normalized tail output).
 *
 * Maps the four tail shapes (client/freelancer/marketplace/marketing/admin
 * team results and the AG-001 orchestrator response) into one bounded result
 * surfaced by the AIOS. Statuses reuse the architecture vocabulary.
 */

import { AggregationStatus } from '../agents/ag-001-master-orchestrator/aggregation/index.js';
import type { OrchestratorResponse } from '../agents/ag-001-master-orchestrator/orchestrator/types/index.js';
import type { AiosExecutionTarget, AiosRequestStatus } from './types.js';

/** A normalized execution outcome produced by the EXECUTE tail. */
export interface ExecutionCatcher {
  readonly target: AiosExecutionTarget;
  readonly status: AiosRequestStatus;
  readonly responseText: string;
  readonly structuredData?: Readonly<Record<string, unknown>>;
  readonly agents: readonly string[];
  readonly confidence?: number;
  readonly coordinationId?: string;
  readonly coordinationStatus?: string;
  readonly memoryReferences?: readonly string[];
  readonly knowledgeReferences?: readonly string[];
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Maps a team request status to the AIOS status vocabulary. */
export function toAiosStatus(status: string): AiosRequestStatus {
  switch (status) {
    case 'COMPLETED':
      return AggregationStatus.Success;
    case 'COMPLETED_PARTIAL':
      return AggregationStatus.Partial;
    case 'CANCELLED':
      return AggregationStatus.Cancelled;
    case 'TIMED_OUT':
      return AggregationStatus.TimedOut;
    case 'FAILED':
      return AggregationStatus.Failed;
    case 'SUCCESS':
    case 'PARTIAL':
    default:
      return status as AggregationStatus;
  }
}

interface TeamResultLike {
  readonly status?: string;
  readonly response?: string;
  readonly structuredData?: Readonly<Record<string, unknown>>;
  readonly agents?: readonly string[];
  readonly confidence?: number;
  readonly coordinationId?: string;
  readonly coordinationStatus?: string;
  readonly memoryReferences?: readonly string[];
  readonly knowledgeReferences?: readonly string[];
}

function isTeamResult(value: unknown): value is TeamResultLike {
  return typeof value === 'object' && value !== null && 'status' in value && 'response' in value;
}

/** Maps an executing resource tail, or orchestrator tail, into a normalized result. */
export function normalizeExecutionResult(
  target: AiosExecutionTarget,
  value: TeamResultLike | OrchestratorResponse,
  startedAtMs: number,
): ExecutionCatcher {
  const completedAtMs = Date.now();
  if (isTeamResult(value)) {
    return {
      target,
      status: toAiosStatus(value.status ?? 'FAILED'),
      responseText: typeof value.response === 'string' ? value.response : '',
      structuredData: value.structuredData,
      agents: value.agents ?? [],
      confidence: value.confidence,
      coordinationId: value.coordinationId,
      coordinationStatus: value.coordinationStatus,
      memoryReferences: value.memoryReferences,
      knowledgeReferences: value.knowledgeReferences,
      startedAtMs,
      completedAtMs,
    };
  }
  const outputs = value.aggregated?.outputs ?? [];
  const lines: string[] = [];
  for (const output of outputs) {
    if (typeof output.output === 'string' && output.output.length > 0) {
      lines.push(output.output);
    }
  }
  return {
    target,
    status: value.status as AiosRequestStatus,
    responseText: lines.join(' ').trim(),
    structuredData: undefined,
    agents: value.execution?.stepResults.map((s) => s.agentId) ?? [],
    confidence: value.intent.confidence,
    startedAtMs,
    completedAtMs,
  };
}
