/**
 * Sprint 26 — AIOS idempotency.
 *
 * A bounded, in-memory deduplication window keyed by a caller-supplied
 * idempotency key. Retries within the window replay the original response;
 * conflicting concurrent requests with the same key are rejected.
 */

import { AiosError, AiosErrorCode } from './errors.js';
import type { AiosResponse } from './types.js';

export interface IdempotencyState {
  readonly key: string;
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

export class AiosIdempotencyRegistry {
  private readonly states = new Map<string, IdempotencyState>();

  constructor(private readonly windowMs: number = 300_000) {}

  isExpired(state: IdempotencyState, now = Date.now()): boolean {
    return now >= state.expiresAtMs;
  }

  claim(key: string, requestId: string, now = Date.now()): IdempotencyClaim {
    const existing = this.states.get(key);
    if (existing === undefined || this.isExpired(existing, now)) {
      this.states.set(key, {
        key,
        requestId,
        state: 'in-flight',
        createdAtMs: now,
        expiresAtMs: now + this.windowMs,
      });
      return { outcome: 'new' };
    }
    if (existing.requestId === requestId) {
      return existing.response !== undefined
        ? { outcome: 'replay', response: existing.response }
        : { outcome: 'conflict', existingRequestId: existing.requestId };
    }
    return { outcome: 'conflict', existingRequestId: existing.requestId };
  }

  complete(key: string, response: AiosResponse, now = Date.now()): void {
    const existing = this.states.get(key);
    if (existing !== undefined && !this.isExpired(existing, now)) {
      this.states.set(key, { ...existing, state: 'completed', response });
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
}
