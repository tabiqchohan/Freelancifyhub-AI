/**
 * Sprint 25 — Admin AI Team v1. Strict, bounded request validation.
 *
 * All admin content — analytics/fraud/health signals, AI-operation proposals,
 * executive facts — is treated as untrusted data (Sprint 25 §6). The schema
 * caps sizes explicitly, disallows unknown keys, bounds every array, and the
 * parser re-attaches the cooperative cancellation handle after validation so
 * AbortSignals never leak into serialized shapes.
 */

import { z } from 'zod';

import {
  ADMIN_CAPABILITY_TARGETS,
  ADMIN_MAX_KPIS,
  ADMIN_MAX_METRICS,
  ADMIN_MAX_QUERY_BYTES,
  ADMIN_MAX_SIGNALS,
} from './constants.js';
import { AdminAIError, ADMIN_AI_ERROR_CODES } from './errors.js';
import type { AdminCancellation, AdminRequest } from './types.js';

const NAMESPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const adminActorSchema = z
  .object({
    actorId: z.string().min(1).max(128),
    namespaces: z.array(z.string().regex(NAMESPACE_RE)).max(8).default(['default']),
    role: z.string().max(64).optional(),
    adminScopes: z.array(z.string().max(64)).max(8).default([]),
    securityClearance: z.string().max(64).optional(),
    availability: z.string().max(64).optional(),
  })
  .strict();

const adminToolCallSchema = z
  .object({
    name: z.string().min(1).max(64),
    input: z.unknown(),
  })
  .strict();

const adminTaskSchema = z
  .object({
    capabilityId: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => value in ADMIN_CAPABILITY_TARGETS, {
        message: 'unsupported admin capability',
      }),
    agentId: z.string().min(1).max(16).optional(),
    objective: z.string().min(1).max(256).optional(),
    requiredTools: z.array(z.string().min(1).max(64)).max(4).optional(),
    toolCalls: z.array(adminToolCallSchema).max(4).optional(),
    mode: z.enum(['single', 'agentic']).optional(),
  })
  .strict();

const adminKpiFactSchema = z
  .object({
    name: z.string().min(1).max(128),
    value: z.number().finite(),
    unit: z.string().max(32).optional(),
    period: z.string().max(64).optional(),
    note: z.string().max(512).optional(),
  })
  .strict();

const adminPermittedDatasetSchema = z
  .object({
    scope: z.string().min(1).max(64),
    dataset: z.string().min(1).max(128),
  })
  .strict();

const adminAnalyticsBriefSchema = z
  .object({
    query: z.string().max(ADMIN_MAX_QUERY_BYTES).optional(),
    permittedDataset: z.array(adminPermittedDatasetSchema).max(4).optional(),
    facts: z.array(adminKpiFactSchema).max(ADMIN_MAX_KPIS).optional(),
  })
  .strict();

const adminFraudSignalEvidenceSchema = z
  .object({
    label: z.string().max(64).optional(),
    detail: z.string().max(512).optional(),
  })
  .strict();

const adminFraudSignalSchema = z
  .object({
    signalId: z.string().min(1).max(64),
    signalType: z.string().max(64).optional(),
    severity: z.string().max(32).optional(),
    observedAt: z.string().min(1).max(64),
    evidence: z.array(adminFraudSignalEvidenceSchema).max(8).optional(),
  })
  .strict();

const adminFraudBriefSchema = z
  .object({
    signals: z.array(adminFraudSignalSchema).max(ADMIN_MAX_SIGNALS).optional(),
    policyScope: z.string().max(128).optional(),
  })
  .strict();

const adminMetricFactSchema = z
  .object({
    name: z.string().min(1).max(128),
    value: z.number().finite(),
    unit: z.string().max(32).optional(),
    threshold: z.number().finite().optional(),
    observedAt: z.string().max(64).optional(),
  })
  .strict();

const adminHealthBriefSchema = z
  .object({
    metrics: z.array(adminMetricFactSchema).max(ADMIN_MAX_METRICS).optional(),
    serviceTopology: z
      .array(
        z
          .object({
            service: z.string().min(1).max(128),
            healthy: z.boolean().optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

const adminAiOpsBriefSchema = z
  .object({
    change: z
      .object({
        changeType: z.enum(['feature-flag', 'model-route', 'prompt-version', 'cost-cap']),
        target: z.string().min(1).max(128),
        value: z.string().max(512).optional(),
        reversible: z.boolean().optional(),
        reason: z.string().max(512).optional(),
      })
      .strict()
      .optional(),
    costFacts: z.array(adminKpiFactSchema).max(ADMIN_MAX_KPIS).optional(),
  })
  .strict();

const adminExecutiveBriefSchema = z
  .object({
    kpis: z.array(adminKpiFactSchema).max(ADMIN_MAX_KPIS).optional(),
    period: z.string().max(64).optional(),
  })
  .strict();

const adminInputSchema = z
  .object({
    action: z
      .object({
        kind: z.string().min(1).max(64),
        domain: z.string().max(64).optional(),
        target: z.string().max(256).optional(),
        reason: z.string().max(512).optional(),
      })
      .strict()
      .optional(),
    analytics: adminAnalyticsBriefSchema.optional(),
    fraud: adminFraudBriefSchema.optional(),
    health: adminHealthBriefSchema.optional(),
    aiops: adminAiOpsBriefSchema.optional(),
    executive: adminExecutiveBriefSchema.optional(),
  })
  .strict();

const adminRequestSchema = z
  .object({
    adminRequestId: z.string().min(1).max(64),
    correlationId: z.string().min(1).max(64),
    requestId: z.string().min(1).max(128).optional(),
    traceId: z.string().min(1).max(128).optional(),
    intent: z.string().min(1).max(64).optional(),
    task: adminTaskSchema.optional(),
    input: adminInputSchema.default({}),
    actor: adminActorSchema,
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
 * Validates any entry payload into an {@link AdminRequest}. The cooperative
 * cancellation handle is detached before validation and re-attached after.
 */
export function parseAdminRequest(input: unknown): AdminRequest {
  const candidate = (input ?? {}) as Record<string, unknown>;
  const { cancellation, ...rest } = candidate;
  const result = adminRequestSchema.safeParse(rest);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path =
      issue?.path
        ?.filter(
          (segment): segment is string | number =>
            typeof segment === 'string' || typeof segment === 'number',
        )
        .join('.') ?? '';
    const message = issue?.message ?? 'Invalid admin-AI request';
    throw new AdminAIError(
      ADMIN_AI_ERROR_CODES.INVALID_INPUT,
      path.length > 0 ? `Invalid input at '${path}': ${message}` : message,
    );
  }
  return {
    ...result.data,
    cancellation: isValidCancellation(cancellation) ? cancellation : undefined,
  };
}

function isValidCancellation(value: unknown): value is AdminCancellation {
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
