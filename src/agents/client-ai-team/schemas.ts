/**
 * Sprint 21 — Client AI Team v1. Strict, bounded request validation.
 *
 * All input is treated as untrusted data. The schema caps sizes explicitly,
 * disallows unknown keys, and the parser re-attaches the cooperative
 * cancellation handle after validation so AbortSignals never leak into
 * serialized shapes.
 */

import { z } from 'zod';

import { CLIENT_CAPABILITY_TARGETS, CLIENT_CONTEXT_LIMITS } from './constants.js';
import { ClientAIError, CLIENT_AI_ERROR_CODES } from './errors.js';
import type { ClientCancellation, ClientRequest } from './types.js';

const NAMESPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const clientActorSchema = z
  .object({
    actorId: z.string().min(1).max(128),
    namespaces: z.array(z.string().regex(NAMESPACE_RE)).max(8).default(['default']),
    role: z.string().max(64).optional(),
    organizationId: z.string().max(128).optional(),
    workspaceId: z.string().max(128).optional(),
    projectIds: z.array(z.string().max(128)).max(16).optional(),
    securityClearance: z.string().max(64).optional(),
  })
  .strict();

const clientToolCallSchema = z
  .object({
    name: z.string().min(1).max(64),
    input: z.unknown(),
  })
  .strict();

const clientTaskSchema = z
  .object({
    capabilityId: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => value in CLIENT_CAPABILITY_TARGETS, {
        message: 'unsupported client capability',
      }),
    agentId: z.string().min(1).max(16).optional(),
    objective: z.string().min(1).max(256).optional(),
    requiredTools: z.array(z.string().min(1).max(64)).max(4).optional(),
    toolCalls: z.array(clientToolCallSchema).max(4).optional(),
    mode: z.enum(['single', 'agentic']).optional(),
  })
  .strict();

const clientBudgetSchema = z
  .object({
    min: z.number().min(0).max(1_000_000_000).optional(),
    max: z.number().min(0).max(1_000_000_000).optional(),
  })
  .strict();

const clientTimelineSchema = z
  .object({
    weeksMin: z.number().min(0).max(520).optional(),
    weeksMax: z.number().min(0).max(520).optional(),
  })
  .strict();

const clientInputSchema = z
  .object({
    brief: z.string().max(CLIENT_CONTEXT_LIMITS.maxBriefBytes).optional(),
    headline: z.string().max(256).optional(),
    requirements: z.array(z.string().max(512)).max(20).optional(),
    budget: clientBudgetSchema.optional(),
    timeline: clientTimelineSchema.optional(),
    skills: z.array(z.string().max(64)).max(40).optional(),
    durationHours: z.number().min(0).max(100_000).optional(),
  })
  .strict();

const clientRequestSchema = z
  .object({
    clientRequestId: z.string().min(1).max(64),
    correlationId: z.string().min(1).max(64),
    requestId: z.string().min(1).max(128).optional(),
    traceId: z.string().min(1).max(128).optional(),
    intent: z.string().min(1).max(64).optional(),
    task: clientTaskSchema.optional(),
    input: clientInputSchema.default({}),
    actor: clientActorSchema,
    limits: z
      .object({
        timeoutMs: z.number().min(1000).max(120_000).optional(),
        globalTimeoutMs: z.number().min(1000).max(120_000).optional(),
      })
      .strict()
      .optional(),
    metadata: z.record(z.string().max(128), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (value) => value.intent !== undefined || value.task !== undefined,
    'either intent or task must be provided',
  );

/**
 * Validates any entry payload into a {@link ClientRequest}. The cooperative
 * cancellation handle is detached before validation and re-attached after.
 */
export function parseClientRequest(input: unknown): ClientRequest {
  const candidate = (input ?? {}) as Record<string, unknown>;
  const { cancellation, ...rest } = candidate;
  const result = clientRequestSchema.safeParse(rest);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path =
      issue?.path
        ?.filter(
          (segment): segment is string | number =>
            typeof segment === 'string' || typeof segment === 'number',
        )
        .join('.') ?? '';
    const message = issue?.message ?? 'Invalid client-AI request';
    throw new ClientAIError(
      CLIENT_AI_ERROR_CODES.INVALID_INPUT,
      path.length > 0 ? `Invalid input at '${path}': ${message}` : message,
    );
  }
  return {
    ...result.data,
    cancellation: isValidCancellation(cancellation) ? cancellation : undefined,
  };
}

function isValidCancellation(value: unknown): value is ClientCancellation {
  if (value === undefined || value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.signal === 'object' &&
    candidate.signal !== null &&
    typeof candidate.requested === 'boolean'
  );
}
