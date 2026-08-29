import { MemoryWriteBackPolicy } from './contracts.js';

/**
 * Sprint 8 — memory write-back policy boundary (prompt §11, §12, §17).
 *
 * Sprint 8 does NOT persist raw requests or execution output. This module is a
 * typed policy boundary for future write-back. The default is the safest
 * behavior: NONE — no automatic persistence.
 *
 * Any future implementation MUST be authorization-checked, sanitized, scoped,
 * bounded, deterministic, and auditable before it may write. Persisting raw
 * execution output is explicitly forbidden; a transformation/sanitization
 * boundary is required first.
 */

/** A resolved write-back decision for a given policy. */
export interface WriteBackDecision {
  readonly policy: MemoryWriteBackPolicy;
  /** Whether any persistence may occur for this request. */
  readonly allowed: boolean;
  /** Whether the caller explicitly requested persistence. */
  readonly explicitlyRequested: boolean;
  /** Human-safe reason for the decision (never contains content). */
  readonly reason: string;
}

/** Parses a configured write-back policy string into the enum. */
export function parseWriteBackPolicy(value: string): MemoryWriteBackPolicy {
  switch (value) {
    case MemoryWriteBackPolicy.None:
    case MemoryWriteBackPolicy.Explicit:
    case MemoryWriteBackPolicy.EventBased:
    case MemoryWriteBackPolicy.Selective:
      return value;
    default:
      return MemoryWriteBackPolicy.None;
  }
}

/** Resolves whether write-back is permitted for a request (fail-safe default). */
export function resolveWriteBack(
  policy: MemoryWriteBackPolicy,
  explicitlyRequested = false,
): WriteBackDecision {
  switch (policy) {
    case MemoryWriteBackPolicy.None:
      return {
        policy,
        allowed: false,
        explicitlyRequested: false,
        reason: 'write-back disabled; no automatic persistence',
      };
    case MemoryWriteBackPolicy.Explicit:
      return {
        policy,
        allowed: explicitlyRequested,
        explicitlyRequested,
        reason: explicitlyRequested
          ? 'explicit write-back requested'
          : 'write-back requires explicit request',
      };
    case MemoryWriteBackPolicy.EventBased:
      return {
        policy,
        allowed: explicitlyRequested,
        explicitlyRequested,
        reason: explicitlyRequested
          ? 'event-based write-back triggered'
          : 'write-back requires an approved event or explicit request',
      };
    case MemoryWriteBackPolicy.Selective:
      return {
        policy,
        allowed: explicitlyRequested,
        explicitlyRequested,
        reason: explicitlyRequested
          ? 'selective write-back authorized'
          : 'selective write-back requires explicit authorization',
      };
    default:
      return {
        policy: MemoryWriteBackPolicy.None,
        allowed: false,
        explicitlyRequested: false,
        reason: 'unknown write-back policy; defaulting to none',
      };
  }
}
