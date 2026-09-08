/**
 * Sprint 22 — Freelancer AI Team v1. Strict, bounded request validation.
 *
 * All input is treated as untrusted data. The schema caps sizes explicitly,
 * disallows unknown keys, and the parser re-attaches the cooperative
 * cancellation handle after validation so AbortSignals never leak into
 * serialized shapes.
 */

import { z } from 'zod';

import {
  FREELANCER_CAPABILITY_TARGETS,
  FREELANCER_CONTEXT_LIMITS,
  FREELANCER_MAX_DRAFT_BYTES,
  FREELANCER_MAX_REQUIREMENTS,
} from './constants.js';
import { FreelancerAIError, FREELANCER_AI_ERROR_CODES } from './errors.js';
import type { FreelancerCancellation, FreelancerRequest } from './types.js';

const NAMESPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const freelancerActorSchema = z
  .object({
    actorId: z.string().min(1).max(128),
    namespaces: z.array(z.string().regex(NAMESPACE_RE)).max(8).default(['default']),
    role: z.string().max(64).optional(),
    securityClearance: z.string().max(64).optional(),
    availability: z.string().max(64).optional(),
  })
  .strict();

const freelancerToolCallSchema = z
  .object({
    name: z.string().min(1).max(64),
    input: z.unknown(),
  })
  .strict();

const freelancerTaskSchema = z
  .object({
    capabilityId: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => value in FREELANCER_CAPABILITY_TARGETS, {
        message: 'unsupported freelancer capability',
      }),
    agentId: z.string().min(1).max(16).optional(),
    objective: z.string().min(1).max(256).optional(),
    requiredTools: z.array(z.string().min(1).max(64)).max(4).optional(),
    toolCalls: z.array(freelancerToolCallSchema).max(4).optional(),
    mode: z.enum(['single', 'agentic']).optional(),
  })
  .strict();

const freelancerBudgetSchema = z
  .object({
    min: z.number().min(0).max(1_000_000_000).optional(),
    max: z.number().min(0).max(1_000_000_000).optional(),
  })
  .strict();

const freelancerTimelineSchema = z
  .object({
    weeksMin: z.number().min(0).max(520).optional(),
    weeksMax: z.number().min(0).max(520).optional(),
  })
  .strict();

const freelancerExperienceSchema = z
  .object({
    years: z.number().min(0).max(80).optional(),
  })
  .strict();

const freelancerProfileSchema = z
  .object({
    headline: z.string().max(256).optional(),
    bio: z.string().max(FREELANCER_CONTEXT_LIMITS.maxBriefBytes).optional(),
    skills: z.array(z.string().max(64)).max(40).optional(),
    experience: freelancerExperienceSchema.optional(),
    portfolioUrl: z.string().max(512).optional(),
    hourlyRate: z.number().min(0).max(1_000_000).optional(),
    availability: z.string().max(64).optional(),
    location: z.string().max(128).optional(),
  })
  .strict();

const freelancerProjectSchema = z
  .object({
    title: z.string().max(256).optional(),
    description: z.string().max(FREELANCER_CONTEXT_LIMITS.maxBriefBytes).optional(),
    requirements: z.array(z.string().max(512)).max(FREELANCER_MAX_REQUIREMENTS).optional(),
    requiredSkills: z.array(z.string().max(64)).max(40).optional(),
    category: z.string().max(64).optional(),
    budget: freelancerBudgetSchema.optional(),
    timeline: freelancerTimelineSchema.optional(),
  })
  .strict();

const freelancerActivitySchema = z
  .object({
    proposalsCount: z.number().min(0).max(1_000_000).optional(),
    projectsCompleted: z.number().min(0).max(100_000).optional(),
    ongoingProjects: z.number().min(0).max(100_000).optional(),
    totalEarnings: z.number().min(0).max(1_000_000_000_000).optional(),
    averageRating: z.number().min(0).max(5).optional(),
    reviewCount: z.number().min(0).max(100_000).optional(),
    onTimeDeliveryRate: z.number().min(0).max(100).optional(),
  })
  .strict();

const freelancerInputSchema = z
  .object({
    profile: freelancerProfileSchema.optional(),
    project: freelancerProjectSchema.optional(),
    activity: freelancerActivitySchema.optional(),
    proposalDraft: z.string().max(FREELANCER_MAX_DRAFT_BYTES).optional(),
  })
  .strict();

const freelancerRequestSchema = z
  .object({
    freelancerRequestId: z.string().min(1).max(64),
    correlationId: z.string().min(1).max(64),
    requestId: z.string().min(1).max(128).optional(),
    traceId: z.string().min(1).max(128).optional(),
    intent: z.string().min(1).max(64).optional(),
    task: freelancerTaskSchema.optional(),
    input: freelancerInputSchema.default({}),
    actor: freelancerActorSchema,
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
 * Validates any entry payload into a {@link FreelancerRequest}. The cooperative
 * cancellation handle is detached before validation and re-attached after.
 */
export function parseFreelancerRequest(input: unknown): FreelancerRequest {
  const candidate = (input ?? {}) as Record<string, unknown>;
  const { cancellation, ...rest } = candidate;
  const result = freelancerRequestSchema.safeParse(rest);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path =
      issue?.path
        ?.filter(
          (segment): segment is string | number =>
            typeof segment === 'string' || typeof segment === 'number',
        )
        .join('.') ?? '';
    const message = issue?.message ?? 'Invalid freelancer-AI request';
    throw new FreelancerAIError(
      FREELANCER_AI_ERROR_CODES.INVALID_INPUT,
      path.length > 0 ? `Invalid input at '${path}': ${message}` : message,
    );
  }
  return {
    ...result.data,
    cancellation: isValidCancellation(cancellation) ? cancellation : undefined,
  };
}

function isValidCancellation(value: unknown): value is FreelancerCancellation {
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
