import { RoutingValidationError } from '../errors/index.js';
import { IntentId, UserRole, validateIntentResult } from '../../intent/index.js';
import type { RouteRequest, RoutingConstraints } from '../types/index.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the raw routing request structure (prompt §14). */
export function validateRouteRequest(raw: unknown): asserts raw is RouteRequest {
  if (!isRecord(raw)) {
    throw new RoutingValidationError('Routing request must be an object');
  }

  if (!isRecord(raw.request)) {
    throw new RoutingValidationError('Routing request is missing the agent request');
  }

  if (typeof raw.request.agentId !== 'string' || raw.request.agentId.trim().length === 0) {
    throw new RoutingValidationError('Routing request agentId must be a non-empty string');
  }

  if (raw.intent === undefined) {
    throw new RoutingValidationError('Routing request is missing the intent result');
  }

  validateIntentResult(raw.intent as never);

  const intent = (raw.intent as { primary?: { intent?: { id?: unknown } } }).primary?.intent;
  if (intent === undefined || !Object.values(IntentId).includes(intent.id as IntentId)) {
    throw new RoutingValidationError('Routing request has an invalid intent id');
  }

  if (raw.context === undefined || !isRecord(raw.context)) {
    throw new RoutingValidationError('Routing request is missing the context snapshot');
  }

  if (raw.role === undefined || !Object.values(UserRole).includes(raw.role as UserRole)) {
    throw new RoutingValidationError('Routing request has an invalid user role');
  }

  validateConstraints(raw.constraints as RoutingConstraints | undefined);
}

/** Validates routing constraints (prompt §13/§14). */
export function validateConstraints(constraints: RoutingConstraints | undefined): void {
  if (constraints === undefined) {
    return;
  }

  if (
    constraints.allowedRoles !== undefined &&
    !constraints.allowedRoles.every((role) => Object.values(UserRole).includes(role))
  ) {
    throw new RoutingValidationError('Routing constraints contain an invalid role');
  }

  if (
    constraints.excludedAgents !== undefined &&
    new Set(constraints.excludedAgents).size !== constraints.excludedAgents.length
  ) {
    throw new RoutingValidationError('Routing constraints contain duplicate excluded agent ids');
  }

  if (
    constraints.maxCandidates !== undefined &&
    (!Number.isInteger(constraints.maxCandidates) || constraints.maxCandidates < 1)
  ) {
    throw new RoutingValidationError(
      'Routing constraints maxCandidates must be a positive integer',
    );
  }

  if (
    constraints.minConfidence !== undefined &&
    (constraints.minConfidence < 0 || constraints.minConfidence > 1)
  ) {
    throw new RoutingValidationError('Routing constraints minConfidence must be in [0,1]');
  }

  if (
    constraints.maxRoutingCost !== undefined &&
    (constraints.maxRoutingCost < 0 || constraints.maxRoutingCost > 1)
  ) {
    throw new RoutingValidationError('Routing constraints maxRoutingCost must be in [0,1]');
  }
}
