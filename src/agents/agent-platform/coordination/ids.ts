/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Deterministic id
 * generation. Coordination and task ids are server-generated, short and safe;
 * by default a monotonic counter avoids randomness entirely so tests stay
 * reproducible.
 */

import { COORDINATION_ID_PREFIX } from './constants.js';

/** Counter-based, monotonic coordination id sequence (deterministic default). */
export function createCoordinationIdFactory(prefix = COORDINATION_ID_PREFIX): () => string {
  let sequence = 0;
  return () => `${prefix}${(++sequence).toString(36)}`;
}

/** Generates a coordination id using the provided factory or the counter. */
export function resolveCoordinationId(factory?: () => string): string {
  return (factory ?? createCoordinationIdFactory())();
}

/** Generates a stateless unique suffix (used for runtime-free ids). */
export function randomCoordinationSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
