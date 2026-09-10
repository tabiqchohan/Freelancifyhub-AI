/**
 * Sprint 25 — Admin AI Team v1 (AG-501..AG-505).
 *
 * Privileged platform AI team: deterministic analytics (F21), fraud triage,
 * platform health, AI operations and executive insights under explicit role
 * scopes (BR-ADM-1), approval-gated mutating recommendations (BR-ADM-2),
 * safe audit events (BR-ADM-3) and reversible, feature-flagged AI-management
 * proposals (BR-ADM-4). Admin agents never fabricate platform metrics, never
 * auto-ban or execute privileged writes, and never read row-level user data.
 *
 * @packageDocumentation
 */

export * from './constants.js';
export * from './types.js';
export * from './errors.js';
export * from './security.js';
export * from './authorization.js';
export * from './schemas.js';
export * from './context.js';
export * from './router.js';
export * from './workflows.js';
export * from './tooling.js';
export * from './events.js';
export * from './metrics.js';
export * from './agents.js';
export * from './service.js';
