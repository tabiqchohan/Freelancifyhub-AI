import { MemoryLifecycleState } from '../enums/index.js';
import type { IsoTimestamp, MemoryRecord } from '../types/index.js';

/**
 * Retention/TTL mechanics (spec §9, prompt §9). The Sprint 1 foundation only
 * represents and validates the policies — no background scheduler and no
 * automatic deletion from a real database.
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
