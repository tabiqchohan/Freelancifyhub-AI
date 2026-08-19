import type { ExecutionPlan } from '../../planning/types/index.js';
import type { NormalizedResult, ResultGroup } from '../types/index.js';
import { ResultGroup as ResultGroupValue } from '../types/index.js';
import type { ResultGrouper, ResultOrderer } from '../interfaces/index.js';

/**
 * Canonical security sanitization mechanism (prompt §19/§43).
 *
 * A key is sensitive when its canonical form (lower-cased, separator- and
 * camelCase-normalised to `snake_case`) matches either:
 * - a sensitive single token: `password`, `passwd`, `pwd`, `passphrase`,
 *   `token`, `secret`, `authorization`, `credentials`, `cookie`, `ssn`,
 *   `cvv`, `pan`, `pin`; or
 * - a sensitive compound: `api_key`/`apikey`, `access_token`,
 *   `refresh_token`, `session_token`/`session_id`, `auth_token`,
 *   `client_secret`, `private_key`, `access_key`.
 *
 * Matching is case-insensitive, supports nested objects/arrays via
 * {@link sanitizeRecord}, and is non-mutating. The canonical form avoids both
 * false negatives (e.g. `pwd`, `passphrase`, `apikey`, `authToken`,
 * `clientSecret`) and substring false positives (e.g. `company`, `author`,
 * `spin` are not treated as sensitive).
 */
function canonicalKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase();
}

const SENSITIVE_TOKEN_PATTERN =
  /(?:^|_)(?:password|passwd|pwd|passphrase|token|secret|authorization|credentials?|cookie|ssn|cvv|pan|pin)(?:_|$)/;

const SENSITIVE_COMPOUND_PATTERN =
  /(?:^|_)(?:api_?key|apikey|access_?token|refresh_?token|session_?token|session_?id|auth_?token|client_?secret|private_?key|access_?key)(?:_|$)/;

/** Whether a key is considered sensitive. */
export function isSensitiveKey(key: string): boolean {
  const canonical = canonicalKey(key);
  return SENSITIVE_TOKEN_PATTERN.test(canonical) || SENSITIVE_COMPOUND_PATTERN.test(canonical);
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
