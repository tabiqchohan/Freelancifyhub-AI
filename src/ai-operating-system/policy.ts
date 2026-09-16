/**
 * Sprint 26 — AIOS authorization (AUTHORIZE phase).
 *
 * Coarse, capability-driven authorization evaluated before execution. Admin
 * intents require an Admin actor (BR-ADM-1); Guests may only reach
 * platform-level intents. Fail-closed: an unauthorized request is rejected with
 * a stable error code. Fine-grained authorization remains the owning team's
 * responsibility (admin team, AG-002/AG-003/AG-004 matrix).
 */

import { AiosErrorCode } from './errors.js';
import type { RequestContext } from './request-context.js';
import { isAdminRole } from './security.js';

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason?: AiosErrorCode;
}

export interface AiosPolicy {
  evaluate(ctx: RequestContext): PolicyDecision;
}

/** Intents that always require an Admin actor (AG-001 vocabulary). */
const ADMIN_INTENT_PREFIXES = ['admin.', 'system.'];

export class AiOperatingSystemPolicy implements AiosPolicy {
  evaluate(ctx: RequestContext): PolicyDecision {
    const intentId = ctx.route.intentId;
    const role = ctx.actor.role;

    const isAdminIntent = ADMIN_INTENT_PREFIXES.some((prefix) => intentId.startsWith(prefix));
    if (isAdminIntent && !isAdminRole(role)) {
      return { allowed: false, reason: AiosErrorCode.UnauthorizedScope };
    }

    if (role === 'Guest') {
      const platformLevel = ['platform.', 'knowledge.', 'unknown', 'system.'] as const;
      const isPlatformLevel = platformLevel.some((prefix) => intentId.startsWith(prefix));
      if (!isPlatformLevel) {
        return { allowed: false, reason: AiosErrorCode.UnauthorizedScope };
      }
    }

    return { allowed: true };
  }
}

/** Default policy instance used by the composition root. */
export function createDefaultPolicy(): AiosPolicy {
  return new AiOperatingSystemPolicy();
}
