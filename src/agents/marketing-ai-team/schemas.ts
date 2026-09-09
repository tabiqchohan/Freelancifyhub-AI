/**
 * Sprint 24 — Marketing AI Team v1. Strict, bounded request validation.
 *
 * All marketing content is treated as untrusted data (Sprint 24 §6). The
 * schema caps sizes explicitly, disallows unknown keys, bounds every array,
 * and the parser re-attaches the cooperative cancellation handle after
 * validation so AbortSignals never leak into serialized shapes.
 */

import { z } from 'zod';

import {
  MARKETING_CAPABILITY_TARGETS,
  MARKETING_CONTEXT_LIMITS,
  MARKETING_MAX_DOCUMENT_BYTES,
  MARKETING_MAX_HEADINGS,
  MARKETING_MAX_KEYWORDS,
  MARKETING_MAX_SOURCES,
} from './constants.js';
import { MarketingAIError, MARKETING_AI_ERROR_CODES } from './errors.js';
import type { MarketingCancellation, MarketingRequest } from './types.js';

const NAMESPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const marketingActorSchema = z
  .object({
    actorId: z.string().min(1).max(128),
    namespaces: z.array(z.string().regex(NAMESPACE_RE)).max(8).default(['default']),
    role: z.string().max(64).optional(),
    securityClearance: z.string().max(64).optional(),
    availability: z.string().max(64).optional(),
  })
  .strict();

const marketingToolCallSchema = z
  .object({
    name: z.string().min(1).max(64),
    input: z.unknown(),
  })
  .strict();

const marketingTaskSchema = z
  .object({
    capabilityId: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => value in MARKETING_CAPABILITY_TARGETS, {
        message: 'unsupported marketing capability',
      }),
    agentId: z.string().min(1).max(16).optional(),
    objective: z.string().min(1).max(256).optional(),
    requiredTools: z.array(z.string().min(1).max(64)).max(4).optional(),
    toolCalls: z.array(marketingToolCallSchema).max(4).optional(),
    mode: z.enum(['single', 'agentic']).optional(),
  })
  .strict();

const marketingSourceSchema = z
  .object({
    source: z.string().min(1).max(512),
    claim: z.string().min(1).max(2048).optional(),
    url: z.string().max(512).optional(),
  })
  .strict();

const marketingResearchBriefSchema = z
  .object({
    brief: z.string().max(MARKETING_CONTEXT_LIMITS.maxBriefBytes).optional(),
    focus: z.string().max(256).optional(),
    sources: z.array(marketingSourceSchema).max(MARKETING_MAX_SOURCES).optional(),
  })
  .strict();

const marketingSocialBriefSchema = z
  .object({
    platform: z.enum(['linkedin', 'x', 'instagram', 'facebook', 'other']).optional(),
    audience: z.string().max(256).optional(),
    goal: z.string().max(256).optional(),
    brandKeywords: z.array(z.string().max(64)).max(20).optional(),
    userDraft: z.string().max(MARKETING_MAX_DOCUMENT_BYTES).optional(),
  })
  .strict();

const marketingBlogBriefSchema = z
  .object({
    topic: z.string().max(256).optional(),
    outline: z.string().max(MARKETING_CONTEXT_LIMITS.maxBriefBytes).optional(),
    seoKeywords: z.array(z.string().max(64)).max(MARKETING_MAX_KEYWORDS).optional(),
    audience: z.string().max(256).optional(),
    brandKeywords: z.array(z.string().max(64)).max(20).optional(),
    userDraft: z.string().max(MARKETING_MAX_DOCUMENT_BYTES).optional(),
  })
  .strict();

const marketingSeoInputSchema = z
  .object({
    title: z.string().max(512).optional(),
    metaDescription: z.string().max(1024).optional(),
    headings: z.array(z.string().max(1024)).max(MARKETING_MAX_HEADINGS).optional(),
    body: z.string().max(MARKETING_MAX_DOCUMENT_BYTES).optional(),
    keywords: z.array(z.string().max(64)).max(MARKETING_MAX_KEYWORDS).optional(),
  })
  .strict();

const marketingEmailBriefSchema = z
  .object({
    audience: z.string().max(256).optional(),
    subject: z.string().max(512).optional(),
    body: z.string().max(MARKETING_MAX_DOCUMENT_BYTES).optional(),
    cta: z.string().max(512).optional(),
    tone: z.string().max(128).optional(),
    campaignType: z.string().max(128).optional(),
    brandKeywords: z.array(z.string().max(64)).max(20).optional(),
  })
  .strict();

const marketingInputSchema = z
  .object({
    research: marketingResearchBriefSchema.optional(),
    social: marketingSocialBriefSchema.optional(),
    blog: marketingBlogBriefSchema.optional(),
    seo: marketingSeoInputSchema.optional(),
    email: marketingEmailBriefSchema.optional(),
  })
  .strict();

const marketingRequestSchema = z
  .object({
    marketingRequestId: z.string().min(1).max(64),
    correlationId: z.string().min(1).max(64),
    requestId: z.string().min(1).max(128).optional(),
    traceId: z.string().min(1).max(128).optional(),
    intent: z.string().min(1).max(64).optional(),
    task: marketingTaskSchema.optional(),
    input: marketingInputSchema.default({}),
    actor: marketingActorSchema,
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

/** Valid platform names (aligned with budget table + schema enum). */
export type MarketingPlatform = 'linkedin' | 'x' | 'instagram' | 'facebook' | 'other';

/**
 * Validates any entry payload into a {@link MarketingRequest}. The
 * cooperative cancellation handle is detached before validation and
 * re-attached after.
 */
export function parseMarketingRequest(input: unknown): MarketingRequest {
  const candidate = (input ?? {}) as Record<string, unknown>;
  const { cancellation, ...rest } = candidate;
  const result = marketingRequestSchema.safeParse(rest);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path =
      issue?.path
        ?.filter(
          (segment): segment is string | number =>
            typeof segment === 'string' || typeof segment === 'number',
        )
        .join('.') ?? '';
    const message = issue?.message ?? 'Invalid marketing-AI request';
    throw new MarketingAIError(
      MARKETING_AI_ERROR_CODES.INVALID_INPUT,
      path.length > 0 ? `Invalid input at '${path}': ${message}` : message,
    );
  }
  return {
    ...result.data,
    cancellation: isValidCancellation(cancellation) ? cancellation : undefined,
  };
}

function isValidCancellation(value: unknown): value is MarketingCancellation {
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
