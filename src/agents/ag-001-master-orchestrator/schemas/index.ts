import { z } from 'zod';

import { ExecutionStatus } from '../types/index.js';

export const requestContextSchema = z.object({
  traceId: z.string().min(1),
  requestId: z.string().min(1),
  receivedAt: z.string().min(1),
  origin: z.string().optional(),
});

export const agentMetadataSchema = z.object({
  agentId: z.string().min(1),
  traceId: z.string().min(1),
  requestId: z.string().min(1),
  startedAt: z.string().min(1),
  completedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  status: z.nativeEnum(ExecutionStatus),
});

export const errorInfoSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean().optional(),
  cause: z.unknown().optional(),
});

export const agentRequestSchema = z.object({
  agentId: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown().optional(),
  context: requestContextSchema,
});

export const agentResponseSchema = z.object({
  agentId: z.string().min(1),
  requestId: z.string().min(1),
  status: z.nativeEnum(ExecutionStatus),
  payload: z.unknown().optional(),
  metadata: agentMetadataSchema,
  error: errorInfoSchema.optional(),
});

export type AgentRequestShape = z.infer<typeof agentRequestSchema>;
export type AgentResponseShape = z.infer<typeof agentResponseSchema>;
