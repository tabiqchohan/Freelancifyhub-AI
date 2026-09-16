/**
 * Sprint 26 — AIOS final response composition.
 *
 * Builds the bounded, secret-redacted response returned to callers. Structured
 * data is size-capped and stringified only within the boundary.
 */

import type { ExecutionCatcher } from './execution-result.js';
import type { RequestContext } from './request-context.js';
import { redactSecrets } from './security.js';
import type { AiosResponse, AiosStage } from './types.js';

/** Composes the trust boundary for response data (always secret-scanned). */
export function composeAiosResponse(
  ctx: RequestContext,
  execution: ExecutionCatcher,
  stages: readonly AiosStage[],
  options: { readonly secretScanEnabled: boolean },
): AiosResponse {
  return {
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    status: execution.status,
    intent: ctx.route.intentId,
    response: redactSecrets(execution.responseText, options.secretScanEnabled).trim(),
    structuredData: redactStructured(execution.structuredData),
    confidence: execution.confidence,
    stages,
    execution: {
      target: execution.target,
      route: ctx.route,
      intent: ctx.intent,
      startedAt: new Date(execution.startedAtMs).toISOString(),
      completedAt: new Date(execution.completedAtMs).toISOString(),
      durationMs: Math.max(0, execution.completedAtMs - execution.startedAtMs),
      agents: execution.agents,
      coordinationId: execution.coordinationId,
      coordinationStatus: execution.coordinationStatus,
      memoryReferences: execution.memoryReferences,
      knowledgeReferences: execution.knowledgeReferences,
    },
  };
}

const MAX_STRUCTURED_BYTES = 131_072;

/** Cuts and bounds structured data (never surfaces unbounded callbacks). */
function redactStructured(
  data: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (data === undefined) {
    return undefined;
  }
  const json = JSON.stringify(data);
  if (json.length > MAX_STRUCTURED_BYTES) {
    return { truncated: true, bytes: json.length, max: MAX_STRUCTURED_BYTES };
  }
  return boundValue(data, 0) as Readonly<Record<string, unknown>>;
}

function boundValue(value: unknown, depth: number): unknown {
  if (depth > 6) {
    return '[depth-limited]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => boundValue(item, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (count >= 200) {
        out.truncated = true;
        break;
      }
      out[key] = boundValue(item, depth + 1);
      count += 1;
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 10_000) {
    return value.slice(0, 10_000);
  }
  return value;
}
