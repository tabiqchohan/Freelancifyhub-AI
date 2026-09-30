/**
 * Sprint 26 — AIOS idempotency.
 *
 * A bounded, in-memory deduplication window keyed by a caller-supplied
 * idempotency key. Retries within the window replay the original response;
 * conflicting concurrent requests with the same key are rejected.
 *
 * Sprint 35 F-6 — keys are **principal-scoped**. The registry stores one entry
 * per `(principal, key)` pair, so two different authenticated callers can never
 * collide, and a caller can never replay or probe another caller's response by
 * guessing their key. The principal is the identity established by the service
 * boundary (see the runtime auth gate); it is never the caller-asserted
 * `actor.actorId` request field.
 */

import { AiosError, AiosErrorCode } from './errors.js';
import type { AiosResponse } from './types.js';

/** Maximum accepted length of a caller-supplied idempotency key. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Sprint 35 F-6 — maximum live registry entries. Bounds memory when callers
 * supply unbounded distinct keys; further claims are refused rather than
 * silently evicting a live entry (which would break the replay guarantee).
 */
export const MAX_IDEMPOTENCY_ENTRIES = 10_000;

/**
 * Sprint 35 F-6 — principal used when no trusted caller identity was bound to
 * the request. Requests that share this scope also share the keyspace, which is
 * deliberately conservative: it can only cause an extra conflict, never a
 * cross-caller replay.
 */
export const UNSCOPED_IDEMPOTENCY_PRINCIPAL = 'unscoped-principal';

export interface IdempotencyState {
  readonly key: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly response?: AiosResponse;
  readonly state: 'in-flight' | 'completed';
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export type IdempotencyClaim =
  | { readonly outcome: 'new' }
  | { readonly outcome: 'replay'; readonly response: AiosResponse }
  | { readonly outcome: 'conflict'; readonly existingRequestId: string };

/** Rejects keys that are empty, oversized or contain control characters. */
export function assertValidIdempotencyKey(key: string): void {
  if (key.length === 0) {
    throw new AiosError(AiosErrorCode.InvalidInput, 'Idempotency key must not be empty');
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new AiosError(
      AiosErrorCode.InvalidInput,
      `Idempotency key exceeds ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  // eslint-disable-next-line no-control-regex -- intentionally reject C0/C1 controls.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(key)) {
    throw new AiosError(AiosErrorCode.InvalidInput, 'Idempotency key contains control characters');
  }
}

/**
 * Sprint 35 F-6 — composes the registry key. The separator is a NUL so it can
 * never appear in either component (keys are validated above, principals are
 * derived from configuration).
 */
export function scopedIdempotencyKey(principalId: string, key: string): string {
  return `${principalId}\u0000${key}`;
}

export class AiosIdempotencyRegistry {
  private readonly states = new Map<string, IdempotencyState>();
  /** Last time the expiry sweep ran; bounds sweep frequency to amortised O(1). */
  private lastSweepMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly windowMs: number = 300_000) {}

  isExpired(state: IdempotencyState, now = Date.now()): boolean {
    return now >= state.expiresAtMs;
  }

  /**
   * Sprint 35 F-6 — claims `(principalId, key)`. `principalId` must be the
   * identity established by the service boundary, not a request field.
   */
  claim(principalId: string, key: string, requestId: string, now = Date.now()): IdempotencyClaim {
    assertValidIdempotencyKey(key);
    this.maybeSweep(now);
    const scoped = scopedIdempotencyKey(principalId, key);
    const existing = this.states.get(scoped);
    if (existing === undefined) {
      if (this.states.size >= MAX_IDEMPOTENCY_ENTRIES) {
        throw new AiosError(
          AiosErrorCode.IdempotencyConflict,
          'Idempotency window is full; retry with a different key',
        );
      }
      this.states.set(scoped, {
        key,
        principalId,
        requestId,
        state: 'in-flight',
        createdAtMs: now,
        expiresAtMs: now + this.windowMs,
      });
      return { outcome: 'new' };
    }
    if (this.isExpired(existing, now)) {
      this.states.set(scoped, {
        key,
        principalId,
        requestId,
        state: 'in-flight',
        createdAtMs: now,
        expiresAtMs: now + this.windowMs,
      });
      return { outcome: 'new' };
    }
    // Same principal + same key. Same request id means a retry that has not
    // settled yet; anything else is a genuine conflict within the window.
    if (existing.requestId === requestId) {
      return existing.response !== undefined
        ? { outcome: 'replay', response: existing.response }
        : { outcome: 'conflict', existingRequestId: existing.requestId };
    }
    return { outcome: 'conflict', existingRequestId: existing.requestId };
  }

  complete(principalId: string, key: string, response: AiosResponse, now = Date.now()): void {
    const scoped = scopedIdempotencyKey(principalId, key);
    const existing = this.states.get(scoped);
    if (existing !== undefined && !this.isExpired(existing, now)) {
      this.states.set(scoped, { ...existing, state: 'completed', response });
    }
  }

  /**
   * Sprint 33 — releases a key that failed/timed out mid-flight so a client
   * retry is not blocked for the remainder of the window. Idempotent.
   */
  release(principalId: string, key: string): void {
    const scoped = scopedIdempotencyKey(principalId, key);
    const existing = this.states.get(scoped);
    if (existing !== undefined && existing.state === 'in-flight') {
      this.states.delete(scoped);
    }
  }

  /** Throws the bounded conflicting-request error used at the boundary. */
  throwConflict(existingRequestId: string, key: string): never {
    throw new AiosError(AiosErrorCode.IdempotencyConflict, 'Idempotency key already in flight', {
      details: { idempotencyKey: key, existingRequestId },
    });
  }

  entryCount(): number {
    return this.states.size;
  }

  /**
   * Sprint 26 — expires stale entries globally so a rarely-used key can never
   * pin memory.
   *
   * Sprint 35 F-6 — sweeping on every claim is O(n) per request, which becomes
   * O(n^2) for a caller supplying many distinct keys. It now runs at most once
   * per window, giving amortised O(1) claims; the explicit expiry check on each
   * claim still guarantees a stale key is never honoured.
   */
  private maybeSweep(now: number): void {
    if (now - this.lastSweepMs < this.windowMs) {
      return;
    }
    this.lastSweepMs = now;
    this.sweepExpired(now);
  }

  private sweepExpired(now: number): void {
    for (const [scoped, state] of this.states) {
      if (this.isExpired(state, now)) {
        this.states.delete(scoped);
      }
    }
  }
}
