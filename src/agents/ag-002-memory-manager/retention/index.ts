import { MemoryLifecycleState, MemoryType } from '../enums/index.js';
import type { IsoTimestamp, MemoryRecord } from '../types/index.js';

/**
 * Retention/TTL mechanics (spec §9, prompt §9). Sprint 1 represented and
 * validated the policies; Sprint 2 adds deterministic evaluation into a
 * {@link MemoryRetentionDecision}. No background scheduler and no automatic
 * deletion from a real database in this sprint.
 */

/** Computes the effective expiry timestamp from a TTL, or undefined for none. */
export function computeExpiry(createdAt: IsoTimestamp, ttlMs?: number): IsoTimestamp | undefined {
  if (ttlMs === undefined || ttlMs <= 0) {
    return undefined;
  }
  return new Date(new Date(createdAt).getTime() + ttlMs).toISOString();
}

/** Whether a record has passed its TTL window (AC-MEM-4: expired = unreachable). */
export function isMemoryExpired(
  record: { readonly expiresAt?: IsoTimestamp },
  now: Date = new Date(),
): boolean {
  if (record.expiresAt === undefined) {
    return false;
  }
  return new Date(record.expiresAt).getTime() <= now.getTime();
}

/** Convenience predicate used by repository/tests for a live (non-terminal) record. */
export function isMemoryLive(record: Pick<MemoryRecord, 'lifecycle'>): boolean {
  return record.lifecycle !== MemoryLifecycleState.Deleted;
}

/** Deterministic retention decision for a single record (prompt §10). */
export enum MemoryRetentionDecision {
  /** Nothing to do — the record stays as-is. */
  KEEP = 'KEEP',
  /** The record has exceeded its TTL and should transition to EXPIRED. */
  EXPIRE = 'EXPIRE',
  /** The record is eligible for the cold/archive tier. */
  ARCHIVE = 'ARCHIVE',
  /** The record is eligible for logical deletion. */
  DELETE = 'DELETE',
}

/**
 * The outcome of a retention evaluation. Carries only safe structured metadata
 * — never memory content (prompt §10, §12).
 */
export interface MemoryRetentionEvaluation {
  readonly decision: MemoryRetentionDecision;
  /** Instant the evaluation was performed (ISO-8601). */
  readonly at: string;
  /** Human-readable reason (safe, no content). */
  readonly reason: string;
  /** Whether the record's TTL has passed at evaluation time. */
  readonly expired: boolean;
  /** Safe structured details; excludes content and secrets. */
  readonly details: Readonly<Record<string, unknown>>;
}

/** Evaluates a single record against TTL + retention policy (spec §9). */
export interface MemoryRetentionEvaluator {
  readonly name: string;
  evaluate(record: MemoryRecord, now: Date): MemoryRetentionEvaluation;
}

/**
 * Default deterministic retention evaluator.
 *
 * Rules derived from the architecture (spec §4, §5, §9) — nothing invented:
 * - A deleted record is terminal → `KEEP` (it may never become active again).
 * - An archived record is under legal hold → `KEEP` (deletion only by a
 *   retention job / legal order, which is deferred).
 * - An active record that has passed its TTL:
 *   - conversation (`rolling_window`): `ARCHIVE` (spec §4.2 "TTL then archived");
 *   - temporary / session (`none`, TTL-driven): `DELETE` (spec §4.8 "sweeper on
 *     TTL", §4.9 "purged at logout/expiry");
 *   - anything else: `EXPIRE` (fallback that keeps the record reachable in the
 *     EXPIRED state until a later decision).
 * - An EXPIRED record follows the same per-type end state.
 * - Unknown/ malformed retention kinds degrade to the conservative `EXPIRE`
 *   fallback rather than throwing.
 */
export class DefaultMemoryRetentionEvaluator implements MemoryRetentionEvaluator {
  readonly name = 'default-memory-retention';

  evaluate(record: MemoryRecord, now: Date): MemoryRetentionEvaluation {
    const expired = isMemoryExpired(record, now);
    const at = now.toISOString();
    const baseDetails: Readonly<Record<string, unknown>> = {
      namespace: record.namespace,
      key: record.key,
      type: record.type,
      lifecycle: record.lifecycle,
      retentionKind: record.retention.kind,
      expiresAt: record.expiresAt,
      ttlMs: record.ttlMs,
    };

    if (record.lifecycle === MemoryLifecycleState.Deleted) {
      return this.decide(
        MemoryRetentionDecision.KEEP,
        at,
        'terminal (deleted)',
        expired,
        baseDetails,
      );
    }

    if (record.lifecycle === MemoryLifecycleState.Archived) {
      return this.decide(
        MemoryRetentionDecision.KEEP,
        at,
        'archived under legal hold; deletion deferred to a retention job',
        expired,
        baseDetails,
      );
    }

    if (!expired) {
      return this.decide(MemoryRetentionDecision.KEEP, at, 'not expired', expired, baseDetails);
    }

    const endState = this.endStateFor(record);
    if (
      record.lifecycle === MemoryLifecycleState.Expired &&
      endState.decision === MemoryRetentionDecision.EXPIRE
    ) {
      return this.decide(
        MemoryRetentionDecision.KEEP,
        at,
        'already expired; awaiting an archive/delete decision',
        expired,
        baseDetails,
      );
    }

    return this.decide(endState.decision, at, endState.reason, expired, baseDetails);
  }

  private endStateFor(record: MemoryRecord): {
    decision: MemoryRetentionDecision;
    reason: string;
  } {
    if (record.retention.kind === 'rolling_window') {
      return {
        decision: MemoryRetentionDecision.ARCHIVE,
        reason: 'TTL exceeded; conversation retention archives after TTL',
      };
    }
    if (record.type === MemoryType.Temporary || record.type === MemoryType.Session) {
      return {
        decision: MemoryRetentionDecision.DELETE,
        reason: 'TTL exceeded; temporary/session memory is purged on expiry',
      };
    }
    return {
      decision: MemoryRetentionDecision.EXPIRE,
      reason: 'TTL exceeded; marking expired pending a retention decision',
    };
  }

  private decide(
    decision: MemoryRetentionDecision,
    at: string,
    reason: string,
    expired: boolean,
    details: Readonly<Record<string, unknown>>,
  ): MemoryRetentionEvaluation {
    return { decision, at, reason, expired, details: { ...details, decision } };
  }
}
