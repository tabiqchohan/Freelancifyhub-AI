import { ValidationError } from '../../errors/index.js';
import { UserRole } from '../../intent/index.js';
import { createRequestId, createTraceId } from '../../utils/ids.js';
import type { NormalizedOrchestrationRequest, OrchestrationRequest } from '../types/index.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the raw orchestration input without generating new identifiers.
 * Throws {@link ValidationError} for malformed inputs (prompt §3 step 2).
 */
export function validateOrchestrationRequest(input: unknown): OrchestrationRequest {
  if (!isRecord(input)) {
    throw new ValidationError('Orchestration request must be an object', {
      details: { field: 'root' },
    });
  }

  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    throw new ValidationError('Orchestration request text must be a non-empty string', {
      details: { field: 'text' },
    });
  }

  if (!Object.values(UserRole).includes(input.role as UserRole)) {
    throw new ValidationError('Orchestration request role must be a valid user role', {
      details: { field: 'role' },
    });
  }

  return input as unknown as OrchestrationRequest;
}

/**
 * Validates the raw orchestration input and returns a normalized copy with
 * correlation identifiers filled in when the caller did not supply them.
 * Never mutates the caller's object.
 */
export function normalizeOrchestrationRequest(input: unknown): NormalizedOrchestrationRequest {
  const validated = validateOrchestrationRequest(input);

  return {
    text: validated.text,
    role: validated.role,
    requestId: validated.requestId ?? createRequestId(),
    traceId: validated.traceId ?? createTraceId(),
    origin: validated.origin,
    contextItems: validated.contextItems,
    budget: validated.budget,
    routingConstraints: validated.routingConstraints,
    planningConstraints: validated.planningConstraints,
  };
}
