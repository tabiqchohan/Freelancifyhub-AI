import type { ExecutionPlan } from '../../planning/types/index.js';
import type { NormalizedResult, ResultGroup } from '../types/index.js';
import { ResultGroup as ResultGroupValue } from '../types/index.js';
import type { ResultGrouper, ResultOrderer } from '../interfaces/index.js';

/** Keys that must never leak into metadata or aggregated output (prompt §19/§43). */
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|auth|authorization|cookie|credential|private[-_]?key|access[-_]?key|session[-_]?id|ssn|credit[-_]?card|pan|pin|cvv)/i;

/** Whether a metadata key is considered sensitive. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Deeply strips sensitive keys from a record without mutating the input. */
export function sanitizeRecord(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRecord(item));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      if (isSensitiveKey(key)) {
        continue;
      }
      sanitized[key] = sanitizeRecord(nested);
    }
    return sanitized;
  }
  return value;
}

/** Deterministic ordering of normalized results (prompt §3/§31). */
export class DeterministicResultOrderer implements ResultOrderer {
  readonly name = 'deterministic-result-orderer';

  order(results: readonly NormalizedResult[], plan?: ExecutionPlan): readonly NormalizedResult[] {
    const planPositions = new Map<string, number>();
    if (plan !== undefined) {
      plan.steps.forEach((step, index) => {
        planPositions.set(step.stepId, index);
      });
    }

    return [...results].sort((a, b) => {
      const planA = planPositions.get(a.stepId) ?? Number.MAX_SAFE_INTEGER;
      const planB = planPositions.get(b.stepId) ?? Number.MAX_SAFE_INTEGER;
      if (planA !== planB) {
        return planA - planB;
      }
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      const startedA = a.startedAt ?? '';
      const startedB = b.startedAt ?? '';
      if (startedA !== startedB) {
        return startedA.localeCompare(startedB);
      }
      return a.stepId.localeCompare(b.stepId);
    });
  }
}

/** Deterministic grouping of normalized results (prompt §4/§32). */
export class DefaultResultGrouper implements ResultGrouper {
  readonly name = 'default-result-grouper';

  group(
    results: readonly NormalizedResult[],
  ): Readonly<Partial<Record<ResultGroup, readonly NormalizedResult[]>>> {
    const grouped: Partial<Record<ResultGroup, NormalizedResult[]>> = {};

    for (const result of results) {
      const bucket = grouped[result.group];
      if (bucket === undefined) {
        grouped[result.group] = [result];
      } else {
        bucket.push(result);
      }
    }

    return grouped;
  }
}

/** The deterministic ordering of result group buckets (prompt §4/§32). */
export const RESULT_GROUP_ORDER: readonly ResultGroup[] = [
  ResultGroupValue.Successful,
  ResultGroupValue.Failed,
  ResultGroupValue.Partial,
  ResultGroupValue.Cancelled,
  ResultGroupValue.TimedOut,
  ResultGroupValue.Skipped,
  ResultGroupValue.Pending,
];

export type { ResultGroup as ResultGroupValue };
