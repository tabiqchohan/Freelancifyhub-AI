/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Zod validation.
 *
 * Every coordination payload crossing an agent/subsystem boundary is validated.
 * Bounds are server-controlled constants; unknown fields are rejected so no
 * coordination can silently carry unvalidated configuration.
 */

import { z } from 'zod';

import {
  COORDINATION_DEFAULT_RETRY,
  COORDINATION_MAX_MESSAGE_BYTES,
  COORDINATION_MAX_TASKS,
} from './constants.js';
import { CoordinationPlanInvalidError, CoordinationMessageValidationError } from './errors.js';
import {
  AggregationStrategy,
  ConflictPolicy,
  CoordinationMode,
  TaskFailurePolicy,
  TaskStatus,
  type CoordinationRequest,
  type CoordinationTaskInput,
} from './types.js';

/** Task statuses must be deterministic and validated. */
export const coordinationTaskStatusSchema = z.enum(
  Object.values(TaskStatus) as [string, ...string[]],
);

/** Coordination mode must be one of the supported values. */
export const coordinationModeSchema = z.enum(
  Object.values(CoordinationMode) as [string, ...string[]],
);

/** Task failure policies. */
export const taskFailurePolicySchema = z.enum(
  Object.values(TaskFailurePolicy) as [string, ...string[]],
);

/** Conflict policies. */
export const conflictPolicySchema = z.enum(Object.values(ConflictPolicy) as [string, ...string[]]);

/** Aggregation strategies. */
export const aggregationStrategySchema = z.enum(
  Object.values(AggregationStrategy) as [string, ...string[]],
);

/** Bounded task retry policy (no infinite loops). */
export const taskRetryPolicySchema = z
  .object({
    maxRetries: z.number().int().min(0).max(5),
    retryable: z.boolean(),
    backoffMs: z.number().int().min(0).max(60_000),
    backoffMultiplier: z.number().min(1).max(10),
    maxBackoffMs: z.number().int().min(0).max(600_000),
  })
  .strict();

/** Coordination scope/limits (bounds applied at parse time). */
export const coordinationLimitsSchema = z
  .object({
    maxTasks: z.number().int().min(1).max(64).optional(),
    maxConcurrentTasks: z.number().int().min(1).max(64).optional(),
    maxTasksPerAgent: z.number().int().min(1).max(64).optional(),
    globalTimeoutMs: z.number().int().min(1).max(3600_000).optional(),
    defaultTaskTimeoutMs: z.number().int().min(1).max(600_000).optional(),
    maxMessageBytes: z.number().int().min(1024).max(1_048_576).optional(),
  })
  .strict();

/** Coordination id (server-generated when omitted). */
export const coordinationIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_-]*$/, 'coordination id is invalid');

/** Task id within a plan. */
export const coordinationTaskIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, 'task id is invalid');

/** A single pre-built task input from AG-001 (strict). */
export const coordinationTaskInputSchema = z
  .object({
    taskId: coordinationTaskIdSchema,
    agentId: z.string().min(1).max(200),
    objective: z.string().min(1).max(4000),
    input: z.unknown().optional(),
    dependencies: z.array(coordinationTaskIdSchema).max(COORDINATION_MAX_TASKS).optional(),
    requiredCapabilities: z.array(z.string().min(1).max(200)).max(16).optional(),
    requiredTools: z.array(z.string().min(1).max(200)).max(16).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    timeoutMs: z.number().int().min(1).max(600_000).optional(),
    retry: taskRetryPolicySchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** The coordination request (serializable surface). */
export const coordinationRequestSchema = z
  .object({
    coordinationId: coordinationIdSchema.optional(),
    correlationId: z.string().min(1).max(200),
    parentExecutionId: z.string().max(200).optional(),
    requester: z.string().min(1).max(200),
    objective: z.string().min(1).max(4000),
    contextReference: z.string().max(200).optional(),
    tasks: z.array(coordinationTaskInputSchema).min(1).max(COORDINATION_MAX_TASKS).optional(),
    participatingAgents: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(COORDINATION_MAX_TASKS)
      .optional(),
    mode: coordinationModeSchema,
    limits: coordinationLimitsSchema.optional(),
    deadline: z.number().int().min(1).optional(),
    failurePolicy: taskFailurePolicySchema.optional(),
    conflictPolicy: conflictPolicySchema.optional(),
    aggregation: aggregationStrategySchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((data) => data.tasks !== undefined || data.participatingAgents !== undefined, {
    message: 'coordination request must provide tasks or participatingAgents',
  });

/** A bounded coordination message (Sprint 20 §10). */
export const coordinationMessageSchema = z
  .object({
    messageId: z.string().min(1).max(200),
    coordinationId: coordinationIdSchema,
    sender: z.string().min(1).max(200),
    recipient: z.string().min(1).max(200),
    messageType: z.string().min(1).max(120),
    payload: z.unknown(),
    occurredAt: z.string().min(1).max(200),
    correlationId: z.string().max(200).optional(),
    schemaVersion: z.string().min(1).max(32),
  })
  .strict();

/** Safe structure for a task result (validated before storage/aggregation). */
export const coordinationTaskResultSchema = z
  .object({
    taskId: coordinationTaskIdSchema,
    agentId: z.string().min(1).max(200),
    status: coordinationTaskStatusSchema,
    output: z.unknown().optional(),
    errors: z
      .array(
        z.object({
          code: z.string().min(1).max(200),
          message: z.string().max(4000),
          retryable: z.boolean().default(false),
          details: z.unknown().optional(),
        }),
      )
      .max(16)
      .default([]),
    timing: z.object({
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
      durationMs: z.number().int().min(0),
    }),
    tokenUsage: z
      .object({
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
        totalTokens: z.number().int().min(0).optional(),
      })
      .optional(),
    toolUsage: z
      .object({
        calls: z.number().int().min(0).optional(),
        successes: z.number().int().min(0).optional(),
        failures: z.number().int().min(0).optional(),
      })
      .optional(),
    correlationId: z.string().max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ValidatedCoordinationTaskResult = z.infer<typeof coordinationTaskResultSchema>;

/** Resolved plan limits (defaults applied). */
export type ResolvedCoordinationLimits = z.infer<typeof resolvedCoordinationLimitsSchema>;
export const resolvedCoordinationLimitsSchema = z.object({
  maxTasks: z.number().int().min(1),
  maxConcurrentTasks: z.number().int().min(1),
  maxTasksPerAgent: z.number().int().min(1),
  globalTimeoutMs: z.number().int().min(1),
  defaultTaskTimeoutMs: z.number().int().min(1),
  maxMessageBytes: z.number().int().min(1024),
});

/** Validates a pre-built task input and normalizes optional fields. */
export function parseCoordinationTaskInput(input: unknown): CoordinationTaskInput {
  const parsed = coordinationTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidPlanError(parsed.error);
  }
  return {
    ...parsed.data,
    dependencies: parsed.data.dependencies ?? [],
    requiredCapabilities: parsed.data.requiredCapabilities ?? [],
    requiredTools: parsed.data.requiredTools ?? [],
    priority: parsed.data.priority ?? 0,
    retry: parsed.data.retry ?? { ...COORDINATION_DEFAULT_RETRY },
  };
}

/** Validates a coordination request (cancellation is transient, not schema). */
export function parseCoordinationRequest(input: unknown): CoordinationRequest {
  const transient = input as Readonly<Record<string, unknown>>;
  const cancellation = extractAbortSignal(transient['cancellation']);
  const { cancellation: _cancellation, ...schemaInput } = transient;
  void _cancellation;
  const parsed = coordinationRequestSchema.safeParse(schemaInput);
  if (!parsed.success) {
    throw invalidPlanError(parsed.error);
  }
  return {
    ...(parsed.data as CoordinationRequest),
    cancellation,
  };
}

/** Validates a coordination message before it crosses an agent boundary. */
export function parseCoordinationMessage(
  input: unknown,
): z.infer<typeof coordinationMessageSchema> {
  const parsed = coordinationMessageSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidMessageError(parsed.error);
  }
  return parsed.data;
}

/** Validates a task result before storage/aggregation. */
export function parseTaskResult(input: unknown): ValidatedCoordinationTaskResult {
  const parsed = coordinationTaskResultSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidMessageError(parsed.error);
  }
  return parsed.data;
}

/** Bounded payload check used before storing/forwarding messages. */
export function assertMessageSize(
  payload: unknown,
  maxBytes: number = COORDINATION_MAX_MESSAGE_BYTES,
): void {
  const size = serializedSize(payload);
  if (size > maxBytes) {
    throw new CoordinationMessageValidationError(
      `coordination message payload exceeds ${maxBytes} bytes`,
      { size, maxBytes },
    );
  }
}

function serializedSize(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : new TextEncoder().encode(serialized).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function extractAbortSignal(value: unknown): AbortSignal | undefined {
  return isAbortSignal(value) ? (value as AbortSignal) : undefined;
}

function isAbortSignal(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { aborted?: unknown; addEventListener?: unknown };
  return typeof candidate.aborted === 'boolean' && typeof candidate.addEventListener === 'function';
}

function invalidPlanError(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): CoordinationPlanInvalidError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  return new CoordinationPlanInvalidError('coordination request failed validation', { issues });
}

function invalidMessageError(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): CoordinationMessageValidationError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  return new CoordinationMessageValidationError('coordination message failed validation', {
    issues,
  });
}
