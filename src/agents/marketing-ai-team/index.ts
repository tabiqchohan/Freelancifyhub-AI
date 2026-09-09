/**
 * Sprint 24 — Marketing AI Team v1 (public barrel).
 *
 * Groups five marketing agents (AG-401..AG-405 — catalog §13) behind the
 * platform, AG-002 memory, AG-003 knowledge, AG-004 tools and the
 * coordination engine, plus the deterministic marketing intelligence layer
 * (research insight summaries, social drafts, blog drafts, SEO on-page
 * recommendations and lifecycle email drafts). Deterministic-first: the
 * service works with the LLM disabled and never fabricates marketing facts —
 * uncited claims, invented copy, engagement metrics and ranking promises are
 * all refused, and insufficient-data/draft-pending states are reported
 * honestly.
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
