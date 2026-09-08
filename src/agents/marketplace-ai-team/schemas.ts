/**
 * Sprint 23 — Marketplace AI Team v1. Strict, bounded request validation.
 *
 * All marketplace content is treated as untrusted data (Sprint 23 §22). The
 * schema caps sizes explicitly, disallows unknown keys, bounds every array,
 * and the parser re-attaches the cooperative cancellation handle after
 * validation so AbortSignals never leak into serialized shapes.
 */

import { z } from 'zod';

import {
  MARKETPLACE_CAPABILITY_TARGETS,
  MARKETPLACE_CONTEXT_LIMITS,
  MARKETPLACE_MAX_DOCUMENT_BYTES,
  MARKETPLACE_MAX_PROJECTS,
  MARKETPLACE_MAX_REQUIREMENTS,
} from './constants.js';
import { MarketplaceAIError, MARKETPLACE_AI_ERROR_CODES } from './errors.js';
import type { MarketplaceCancellation, MarketplaceRequest } from './types.js';

const NAMESPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const marketplaceActorSchema = z
  .object({
    actorId: z.string().min(1).max(128),
    namespaces: z.array(z.string().regex(NAMESPACE_RE)).max(8).default(['default']),
    role: z.string().max(64).optional(),
    securityClearance: z.string().max(64).optional(),
    availability: z.string().max(64).optional(),
  })
  .strict();

const marketplaceToolCallSchema = z
  .object({
    name: z.string().min(1).max(64),
    input: z.unknown(),
  })
  .strict();

const marketplaceTaskSchema = z
  .object({
    capabilityId: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => value in MARKETPLACE_CAPABILITY_TARGETS, {
        message: 'unsupported marketplace capability',
      }),
    agentId: z.string().min(1).max(16).optional(),
    objective: z.string().min(1).max(256).optional(),
    requiredTools: z.array(z.string().min(1).max(64)).max(4).optional(),
    toolCalls: z.array(marketplaceToolCallSchema).max(4).optional(),
    mode: z.enum(['single', 'agentic']).optional(),
  })
  .strict();

const marketplaceBudgetSchema = z
  .object({
    min: z.number().min(0).max(1_000_000_000).optional(),
    max: z.number().min(0).max(1_000_000_000).optional(),
  })
  .strict();

const marketplaceTimelineSchema = z
  .object({
    weeksMin: z.number().min(0).max(520).optional(),
    weeksMax: z.number().min(0).max(520).optional(),
  })
  .strict();

const marketplaceExperienceSchema = z
  .object({
    years: z.number().min(0).max(80).optional(),
  })
  .strict();

const marketplaceProjectSchema = z
  .object({
    title: z.string().max(256).optional(),
    description: z.string().max(MARKETPLACE_CONTEXT_LIMITS.maxBriefBytes).optional(),
    requirements: z.array(z.string().max(512)).max(MARKETPLACE_MAX_REQUIREMENTS).optional(),
    requiredSkills: z.array(z.string().max(64)).max(40).optional(),
    category: z.string().max(64).optional(),
    budget: marketplaceBudgetSchema.optional(),
    timeline: marketplaceTimelineSchema.optional(),
    status: z.string().max(32).optional(),
    deliverables: z.array(z.string().max(512)).max(10).optional(),
  })
  .strict();

const marketplaceFreelancerSchema = z
  .object({
    id: z.string().max(64).optional(),
    headline: z.string().max(256).optional(),
    bio: z.string().max(MARKETPLACE_CONTEXT_LIMITS.maxBriefBytes).optional(),
    skills: z.array(z.string().max(64)).max(40).optional(),
    experience: marketplaceExperienceSchema.optional(),
    portfolioUrl: z.string().max(512).optional(),
    hourlyRate: z.number().min(0).max(1_000_000).optional(),
    category: z.string().max(64).optional(),
    availability: z.string().max(64).optional(),
  })
  .strict();

const marketplaceMilestoneSchema = z
  .object({
    title: z.string().min(1).max(128),
    amount: z.number().min(0).max(1_000_000_000),
    dueWeeks: z.number().min(0).max(520).optional(),
    deliverable: z.string().max(512).optional(),
  })
  .strict();

const marketplaceAgreementSchema = z
  .object({
    parties: z
      .object({
        clientId: z.string().max(64).optional(),
        freelancerId: z.string().max(64).optional(),
        clientName: z.string().max(128).optional(),
        freelancerName: z.string().max(128).optional(),
      })
      .strict()
      .optional(),
    budget: marketplaceBudgetSchema.optional(),
    fee: z.number().min(0).max(1_000_000_000).optional(),
    milestones: z.array(marketplaceMilestoneSchema).max(12).optional(),
    terms: z.array(z.string().max(512)).max(10).optional(),
    jurisdiction: z.string().max(128).optional(),
  })
  .strict();

const marketplaceMessageSchema = z
  .object({
    senderId: z.string().max(64).optional(),
    recipientId: z.string().max(64).optional(),
    body: z.string().max(MARKETPLACE_MAX_DOCUMENT_BYTES),
    context: z.string().max(512).optional(),
  })
  .strict();

const marketplaceRiskSignalsSchema = z
  .object({
    newAccount: z.boolean().optional(),
    contactOffPlatform: z.boolean().optional(),
    paymentOutsidePlatform: z.boolean().optional(),
    urgencyPressure: z.boolean().optional(),
    suspiciousLink: z.boolean().optional(),
    messageCount: z.number().min(0).max(100_000).optional(),
    reportedBefore: z.boolean().optional(),
  })
  .strict();

const marketplaceReviewSchema = z
  .object({
    engagementId: z.string().max(64).optional(),
    parties: z
      .object({
        reviewerId: z.string().max(64).optional(),
        reviewedId: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
    outcomeAgreed: z.boolean().optional(),
    messages: z.array(z.string().max(1024)).max(20).optional(),
    deliveredOnTime: z.boolean().optional(),
    qualityNotes: z.string().max(512).optional(),
    milestonesCount: z.number().min(0).max(100).optional(),
  })
  .strict();

const marketplaceDisputeSchema = z
  .object({
    disputeId: z.string().max(64).optional(),
    reason: z.string().max(512).optional(),
    openedAt: z.string().max(64).optional(),
    messages: z.array(z.string().max(1024)).max(20).optional(),
    deliverables: z.array(z.string().max(512)).max(10).optional(),
    payments: z.array(z.number().min(0).max(1_000_000_000)).max(10).optional(),
    status: z.string().max(32).optional(),
  })
  .strict();

const marketplaceDatasetSchema = z
  .object({
    projects: z.array(marketplaceProjectSchema).max(MARKETPLACE_MAX_PROJECTS).optional(),
    categories: z.array(z.string().max(64)).max(20).optional(),
  })
  .strict();

const marketplaceInputSchema = z
  .object({
    project: marketplaceProjectSchema.optional(),
    freelancer: marketplaceFreelancerSchema.optional(),
    agreement: marketplaceAgreementSchema.optional(),
    message: marketplaceMessageSchema.optional(),
    signals: marketplaceRiskSignalsSchema.optional(),
    review: marketplaceReviewSchema.optional(),
    dispute: marketplaceDisputeSchema.optional(),
    marketplace: marketplaceDatasetSchema.optional(),
  })
  .strict();

const marketplaceRequestSchema = z
  .object({
    marketplaceRequestId: z.string().min(1).max(64),
    correlationId: z.string().min(1).max(64),
    requestId: z.string().min(1).max(128).optional(),
    traceId: z.string().min(1).max(128).optional(),
    intent: z.string().min(1).max(64).optional(),
    task: marketplaceTaskSchema.optional(),
    input: marketplaceInputSchema.default({}),
    actor: marketplaceActorSchema,
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
 * Validates any entry payload into a {@link MarketplaceRequest}. The
 * cooperative cancellation handle is detached before validation and
 * re-attached after.
 */
export function parseMarketplaceRequest(input: unknown): MarketplaceRequest {
  const candidate = (input ?? {}) as Record<string, unknown>;
  const { cancellation, ...rest } = candidate;
  const result = marketplaceRequestSchema.safeParse(rest);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path =
      issue?.path
        ?.filter(
          (segment): segment is string | number =>
            typeof segment === 'string' || typeof segment === 'number',
        )
        .join('.') ?? '';
    const message = issue?.message ?? 'Invalid marketplace-AI request';
    throw new MarketplaceAIError(
      MARKETPLACE_AI_ERROR_CODES.INVALID_INPUT,
      path.length > 0 ? `Invalid input at '${path}': ${message}` : message,
    );
  }
  return {
    ...result.data,
    cancellation: isValidCancellation(cancellation) ? cancellation : undefined,
  };
}

function isValidCancellation(value: unknown): value is MarketplaceCancellation {
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
