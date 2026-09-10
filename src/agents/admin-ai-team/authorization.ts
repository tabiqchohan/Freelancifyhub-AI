/**
 * Sprint 25 — Admin AI Team v1. Privileged authorization & audit model.
 *
 * BR-ADM-1..4 of docs/product-requirements-v1.md:
 *  - BR-ADM-1: admins and admin-AI act only within explicit role scopes.
 *  - BR-ADM-2: sensitive actions need explicit approval; the AI never executes
 *    a privileged write on its own — it produces approval-gated
 *    recommendations.
 *  - BR-ADM-3: every privileged action is auditable (actor, scope, capability,
 *    timestamp). We only emit fixed, safe audit labels — never user data.
 *  - BR-ADM-4: AI-management changes are feature-flagged and reversible (the
 *    aiops agent always marks proposals reversible/approval-gated).
 *
 * This module is the single decision point. The service, router, agents and
 * tool client all defer to it; a denial is a typed, stable error that never
 * reveals why a resource is restricted.
 */

import { ADMIN_CAPABILITY_IDS, ADMIN_ROLE, ADMIN_SCOPES } from './constants.js';
import {
  AdminAIAccessDeniedError,
  AdminAIAuthorizationError,
  AdminAIError,
  ADMIN_AI_ERROR_CODES,
} from './errors.js';
import type { AdminActor, AdminRecommendation } from './types.js';

/** Read vs mutating classification for a privileged action kind. */
export type AdminActionKind = 'read' | 'mutating';

/** Outcome of a capability/action authorization check. */
export interface AdminAuthorizationResult {
  readonly allowed: boolean;
  readonly actorId: string;
  readonly capabilityId: string;
  readonly scopes: readonly string[];
  readonly reason: string;
}

/** Fixed, safe audit labels (never payload-derived). */
export const ADMIN_AUDIT_LABELS = Object.freeze({
  analytics: 'admin.analytics',
  fraud: 'admin.fraud',
  health: 'admin.health',
  aiops: 'admin.aiops',
  executive: 'admin.executive',
  fallback: 'admin.action',
});

/** Mutating action kinds — a monotonic deny-by-default allow list. */
const MUTATING_ACTION_KINDS: readonly string[] = [
  'ban',
  'unban',
  'suspend',
  'block',
  'refund',
  'dispute',
  'project-close',
  'delete',
  'terminate',
  'config-change',
  'feature-flag',
  'prompt-version',
  'model-route',
  'cost-cap',
  'payment-action',
  'message',
  'trust-score',
];

/**
 * Classifies an admin action kind. Unknown kinds are treated as read
 * (deny-mutating default). Admin-AI never executes mutating actions; the
 * classification only controls whether the produced recommendation must be
 * marked approval-required.
 */
export function classifyAdminAction(actionKind: string | undefined): AdminActionKind {
  if (actionKind !== undefined && MUTATING_ACTION_KINDS.includes(actionKind)) {
    return 'mutating';
  }
  return 'read';
}

/**
 * Returns whether a recommendation of the given kind requires explicit
 * approval before anyone may act on it (BR-ADM-2). All mutating actions
 * require approval; every aiops capability request is treated as a config
 * change and therefore approval-gated (BR-ADM-4).
 */
export function requiresApproval(actionKind: AdminActionKind, capabilityId?: string): boolean {
  if (actionKind === 'mutating') {
    return true;
  }
  return capabilityId === ADMIN_CAPABILITY_IDS.aiOps;
}

/** True when the actor holds at least one of the given scopes (BR-ADM-1). */
export function hasAnyAdminScope(actor: AdminActor, required: readonly string[]): boolean {
  const scopes = actor.adminScopes ?? [];
  if (scopes.length === 0) {
    return false;
  }
  return required.some((scope) => scopes.includes(scope));
}

/** True when the actor's admin identity is usable at all. */
function hasUsableAdminIdentity(actor: AdminActor): boolean {
  const scopes = actor.adminScopes ?? [];
  if (scopes.length === 0) {
    return false;
  }
  if (actor.role !== undefined && actor.role !== '' && actor.role !== ADMIN_ROLE) {
    return false;
  }
  return true;
}

/** Maps a capability id to the set of scopes that authorize it. */
function allowedScopesForCapability(capabilityId: string): readonly string[] {
  switch (capabilityId) {
    case ADMIN_CAPABILITY_IDS.action:
      return ADMIN_SCOPES;
    case ADMIN_CAPABILITY_IDS.analytics:
      return ['users', 'projects', 'payments', 'disputes'];
    case ADMIN_CAPABILITY_IDS.fraud:
      return ['fraud'];
    case ADMIN_CAPABILITY_IDS.health:
      return ADMIN_SCOPES;
    case ADMIN_CAPABILITY_IDS.aiOps:
      return ['ai'];
    case ADMIN_CAPABILITY_IDS.executive:
      return ADMIN_SCOPES;
    default:
      return [];
  }
}

/** True when the actor may exercise the given capability (BR-ADM-1). */
export function canExecuteCapability(actor: AdminActor, capabilityId: string): boolean {
  if (!hasUsableAdminIdentity(actor)) {
    return false;
  }
  if (!allowedScopesForCapability(capabilityId).length) {
    return false;
  }
  return hasAnyAdminScope(actor, allowedScopesForCapability(capabilityId));
}

/**
 * Returns an {@link AdminAuthorizationResult} for the actor + capability. The
 * result is stable and actor-safe; never throws.
 */
export function authorizeCapability(
  actor: AdminActor,
  capabilityId: string,
): AdminAuthorizationResult {
  if (!actor.actorId) {
    return {
      allowed: false,
      actorId: '',
      capabilityId,
      scopes: [],
      reason: 'no actor identity',
    };
  }
  if (!hasUsableAdminIdentity(actor)) {
    return {
      allowed: false,
      actorId: actor.actorId,
      capabilityId,
      scopes: actor.adminScopes ?? [],
      reason: 'admin scopes required',
    };
  }
  const allowed = canExecuteCapability(actor, capabilityId);
  return {
    allowed,
    actorId: actor.actorId,
    capabilityId,
    scopes: actor.adminScopes ?? [],
    reason: allowed ? 'authorized' : 'insufficient scope for capability',
  };
}

/**
 * Authorizes an admin request and throws a typed error when denied.
 * - No/empty identity → {@link AdminAIAuthorizationError} (UNAUTHORIZED).
 * - Missing capability scope → {@link AdminAIAccessDeniedError} (FORBIDDEN).
 */
export function authorizeAdminRequest(actor: AdminActor, capabilityId: string): void {
  if (!actor || !actor.actorId || (actor.adminScopes ?? []).length === 0) {
    throw new AdminAIAuthorizationError('Admin authorization required');
  }
  if (!hasUsableAdminIdentity(actor)) {
    throw new AdminAIAccessDeniedError('Admin role or scopes required');
  }
  if (!canExecuteCapability(actor, capabilityId)) {
    throw new AdminAIAccessDeniedError('Actor lacks the scope required for this capability');
  }
}

/** Fixed, safe audit label for a capability (never payload-derived). */
export function auditLabelForCapability(capabilityId: string): string {
  switch (capabilityId) {
    case ADMIN_CAPABILITY_IDS.analytics:
      return ADMIN_AUDIT_LABELS.analytics;
    case ADMIN_CAPABILITY_IDS.fraud:
      return ADMIN_AUDIT_LABELS.fraud;
    case ADMIN_CAPABILITY_IDS.health:
      return ADMIN_AUDIT_LABELS.health;
    case ADMIN_CAPABILITY_IDS.aiOps:
      return ADMIN_AUDIT_LABELS.aiops;
    case ADMIN_CAPABILITY_IDS.executive:
      return ADMIN_AUDIT_LABELS.executive;
    default:
      return ADMIN_AUDIT_LABELS.fallback;
  }
}

/**
 * Marks a recommendation with its approval/audit contract. Mutating
 * recommendations are always approval-required (BR-ADM-2); aiops proposals
 * are approval-gated and flagged reversible (BR-ADM-4). Returns a bounded
 * copy with only fixed label booleans added — never mutates the input.
 */
export function stampRecommendationApproval(
  recommendation: AdminRecommendation,
): AdminRecommendation {
  const actionKind = classifyAdminAction(recommendation.actionKind ?? 'read');
  const approvalRequired = requiresApproval(actionKind, recommendation.capability);
  return {
    ...recommendation,
    actionKind,
    approvalRequired,
  };
}

/** Marks an error as an authorization failure so QoS can count it safely. */
export function isAuthorizationError(error: unknown): boolean {
  if (error instanceof AdminAIAuthorizationError || error instanceof AdminAIAccessDeniedError) {
    return true;
  }
  if (error instanceof AdminAIError) {
    return (
      error.code === ADMIN_AI_ERROR_CODES.UNAUTHORIZED ||
      error.code === ADMIN_AI_ERROR_CODES.FORBIDDEN
    );
  }
  return false;
}
