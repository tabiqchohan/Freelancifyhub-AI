import { z } from 'zod';

import { MemoryLifecycleState } from '../enums/index.js';
import { MemoryEventValidationError } from '../errors/index.js';
import type { MemoryEventType } from './index.js';

/**
 * Sprint 7 — Typed event validation (spec §4). Rejects malformed audit events
 * instead of silently accepting them. Uses the shared Zod conventions from the
 * config schema. This validates the *canonical stored projection* — services
 * still emit loose transport events, but the EventLog validates before hosting.
 */

export const eventIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'eventId may only contain URL-safe characters');

export const eventTimestampSchema = z.string().datetime({ offset: true });

/** Version numbers are optional but, when present, must be positive integers. */
export const eventVersionSchema = z.number().int().positive().optional();

/** Lifecycle state is optional but, when present, must be a known state. */
export const eventLifecycleSchema = z.nativeEnum(MemoryLifecycleState).optional();

/**
 * The canonical stored-event shape. `type`, `occurredAt` and `namespace`/`key`
 * are required so every audit record is traceable to a memory operation.
 */
export const MemoryEventInputSchema = z.object({
  eventId: eventIdSchema.optional(),
  type: z.custom<MemoryEventType>((value) => typeof value === 'string' && value.length > 0, {
    message: 'event type must be a non-empty string',
  }),
  occurredAt: eventTimestampSchema,
  timestamp: eventTimestampSchema.optional(),
  traceId: z.string().min(1).optional(),
  namespace: z.string().min(1),
  key: z.string().min(1),
  memoryId: z.string().min(1).optional(),
  actorId: z.string().optional(),
  actorType: z.string().optional(),
  actorGroup: z.string().optional(),
  organizationId: z.string().optional(),
  workspaceId: z.string().optional(),
  projectId: z.string().optional(),
  requestId: z.string().optional(),
  correlationId: z.string().optional(),
  source: z.string().optional(),
  service: z.string().optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  category: z.string().optional(),
  version: eventVersionSchema,
  previousVersion: eventVersionSchema,
  previousState: eventLifecycleSchema,
  newState: eventLifecycleSchema,
  reason: z.string().optional(),
  hard: z.boolean().optional(),
  archiveId: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  permission: z.string().optional(),
  targetType: z.string().optional(),
  targetSecurityLevel: z.string().optional(),
  denialReason: z.string().optional(),
  denialCode: z.string().optional(),
  consolidationId: z.string().optional(),
  sourceIds: z.array(z.string().min(1)).optional(),
  outputId: z.string().optional(),
  candidateGroupSize: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type MemoryEventInput = z.infer<typeof MemoryEventInputSchema>;

/**
 * Safely normalises a loose transport {@link MemoryEvent} into the validated
 * canonical input used by the EventLog. Throws a typed
 * {@link MemoryEventValidationError} when the event is malformed.
 */
export function validateMemoryEvent(event: Readonly<Record<string, unknown>>): MemoryEventInput {
  const result = MemoryEventInputSchema.safeParse(event);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => issue.message);
    throw new MemoryEventValidationError('Invalid memory event', {
      details: { issues },
    });
  }
  return result.data;
}

/**
 * Validates that an EventLog query carries sane pagination bounds. Returns the
 * resolved `limit` (defaults to the configured maximum). Throws on bad limits.
 */
export function resolveEventLimit(limit: number | undefined, maxPageSize: number): number {
  const resolved = limit ?? maxPageSize;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new MemoryEventValidationError('Event page limit must be a positive integer', {
      code: 'INVALID_EVENT_PAGINATION',
    });
  }
  if (resolved > maxPageSize) {
    throw new MemoryEventValidationError('Event page limit exceeds the configured maximum', {
      code: 'INVALID_EVENT_PAGINATION',
      details: { limit: resolved, maxPageSize },
    });
  }
  return resolved;
}
