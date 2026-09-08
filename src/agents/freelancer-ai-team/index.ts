/**
 * Sprint 22 — Freelancer AI Team v1 (public barrel).
 *
 * Groups four freelancer agents (AG-201, AG-202, AG-206, AG-207 — catalog
 * §11) behind the platform, AG-002 memory, AG-003 knowledge, AG-004 tools
 * and the coordination engine. Deterministic-first: the service works with
 * the LLM disabled. Profile/proposal generation is bounded by the same
 * fail-closed, nobody-fabricates rules as the Client AI Team.
 */

export * from './constants.js';
export * from './types.js';
export * from './errors.js';
export * from './schemas.js';
export * from './security.js';
export * from './agents.js';
export * from './context.js';
export * from './router.js';
export * from './workflows.js';
export * from './tooling.js';
export * from './events.js';
export * from './metrics.js';
export * from './service.js';
