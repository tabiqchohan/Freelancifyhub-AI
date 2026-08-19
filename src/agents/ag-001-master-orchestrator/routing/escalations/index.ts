import type { RouteCandidate, RouteDecision, RouteEscalation } from '../types/index.js';
import { ConfidenceLevel, EscalationReason, RoutingStatus } from '../types/index.js';
import type { IntentResult, UserRole } from '../../intent/index.js';

/** Inputs needed to compute escalation metadata (prompt §11). */
export interface EscalationInput {
  readonly intent: IntentResult;
  readonly role: UserRole;
  readonly candidates: readonly RouteCandidate[];
  readonly confidence: number;
  readonly confidenceLevel: ConfidenceLevel;
  readonly lowThreshold: number;
  readonly enabled: boolean;
  /** Request-level role restriction from routing constraints (§13). */
  readonly allowedRoles?: readonly UserRole[];
}

/** Result of escalation resolution. */
export interface EscalationResult {
  readonly status: RoutingStatus;
  readonly escalation?: RouteEscalation;
  readonly reasons: RouteDecision['reasons'];
}

/**
 * Deterministic escalation resolution (prompt §11). Escalation is chosen when
 * there is no eligible candidate, confidence is below the low threshold, the
 * role is not allowed by the intent, or escalation is disabled.
 */
export function resolveEscalation(input: EscalationInput): EscalationResult {
  if (!input.enabled) {
    return { status: RoutingStatus.Success, reasons: [] };
  }

  if (input.candidates.length === 0) {
    return {
      status: RoutingStatus.Escalated,
      escalation: {
        reason: EscalationReason.NoMatch,
        message: 'No agent matches the detected intent',
        details: { intentId: input.intent.primary.intent.id },
      },
      reasons: [
        {
          code: 'NO_ELIGIBLE_CANDIDATES',
          message: `No eligible agent for intent ${input.intent.primary.intent.id}`,
        },
      ],
    };
  }

  if (
    input.allowedRoles !== undefined &&
    input.allowedRoles.length > 0 &&
    !input.allowedRoles.includes(input.role)
  ) {
    return {
      status: RoutingStatus.Escalated,
      escalation: {
        reason: EscalationReason.PermissionDenied,
        message: `Role ${input.role} is not allowed by the routing constraints`,
        details: { role: input.role, allowedRoles: input.allowedRoles },
      },
      reasons: [
        {
          code: 'ROLE_NOT_ALLOWED_BY_CONSTRAINT',
          message: `Role ${input.role} cannot route through these constraints`,
        },
      ],
    };
  }

  if (!input.intent.primary.intent.allowedRoles.includes(input.role)) {
    return {
      status: RoutingStatus.Escalated,
      escalation: {
        reason: EscalationReason.PermissionDenied,
        message: `Role ${input.role} is not allowed for intent ${input.intent.primary.intent.id}`,
        details: { role: input.role, intentId: input.intent.primary.intent.id },
      },
      reasons: [
        {
          code: 'ROLE_NOT_ALLOWED',
          message: `Role ${input.role} cannot use intent ${input.intent.primary.intent.id}`,
        },
      ],
    };
  }

  if (input.confidence < input.lowThreshold || input.confidenceLevel === ConfidenceLevel.Low) {
    return {
      status: RoutingStatus.Escalated,
      escalation: {
        reason: EscalationReason.LowConfidence,
        message: `Routing confidence ${input.confidence.toFixed(3)} is below the low threshold ${input.lowThreshold}`,
        details: { confidence: input.confidence, lowThreshold: input.lowThreshold },
      },
      reasons: [
        {
          code: 'LOW_CONFIDENCE',
          message: `Routing confidence below low threshold (${input.confidence.toFixed(3)})`,
        },
      ],
    };
  }

  return { status: RoutingStatus.Success, reasons: [] };
}
