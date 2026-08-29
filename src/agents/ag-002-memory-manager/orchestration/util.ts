import { createTraceId as ag002CreateTraceId } from '../utils/ids.js';

/**
 * Sprint 8 — small deterministic helpers reused by the integration layer.
 * Reuses AG-002's existing id factories (never generates competing ids).
 */
export const canonical = {
  createTraceId: ag002CreateTraceId,
};

/** Bounds an ISO timestamp generated from a fixed clock for determinism. */
export function isoNow(clockIso: string): string {
  return clockIso;
}
