import { z } from 'zod';

import {
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../enums/index.js';
import type { MemoryJsonValue } from '../types/index.js';

/** Recursive JSON-compatible value schema (prompt §4). */
export const memoryJsonValueSchema: z.ZodType<MemoryJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(memoryJsonValueSchema),
    z.record(z.string(), memoryJsonValueSchema),
  ]),
);

/** Structured memory content. */
export const memoryContentSchema = memoryJsonValueSchema;

/** Key-value metadata (bounded via validators against config). */
export const memoryMetadataSchema = z.record(z.string(), memoryJsonValueSchema);

/** Valid ISO-8601 timestamp (parsable, safe for Date round-trips). */
export const isoTimestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), 'expected a valid ISO timestamp');

/** Unique record id in the form `memory_<uuid>`. */
export const memoryIdSchema = z.string().regex(/^memory_[a-zA-Z0-9_-]+$/, 'invalid memory id');

/** Namespace in the form `scope:value` or `scope:value:sub` (spec §6). */
export const memoryNamespaceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z][a-z0-9:_-]*$/i, 'invalid namespace');

/** Logical key within a namespace. */
export const memoryKeySchema = z.string().min(1).max(256);

export const memoryOwnerSchema = z.object({
  kind: z.nativeEnum(MemoryOwnerKind),
  id: z.string().min(1).max(256),
});

export const memorySourceSchema = z.object({
  kind: z.enum(['knowledge_reference', 'summarization', 'external']),
  reference: z.string().min(1).max(1024),
});

export const memoryRetentionPolicySchema = z.object({
  kind: z.enum([
    'none',
    'rolling_window',
    'until_deletion',
    'milestone_summaries',
    'archive_on_close',
    'versioned',
    'annual_consolidation',
    'legal_hold',
    'invalidation',
  ]),
  description: z.string().max(512).optional(),
});

export const memoryRecordSchema = z.object({
  id: memoryIdSchema,
  namespace: memoryNamespaceSchema,
  key: memoryKeySchema,
  type: z.nativeEnum(MemoryType),
  owner: memoryOwnerSchema,
  content: memoryContentSchema,
  metadata: memoryMetadataSchema.default({}),
  priority: z.nativeEnum(MemoryPriority),
  securityLevel: z.nativeEnum(MemorySecurityLevel),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema.optional(),
  ttlMs: z.number().int().min(0).optional(),
  retention: memoryRetentionPolicySchema,
  version: z.number().int().positive(),
  lifecycle: z.nativeEnum(MemoryLifecycleState),
  reason: z.string().min(1).max(1024),
  traceId: z.string().min(1),
  source: memorySourceSchema.optional(),
});

export const memoryRecordFilterSchema = z.object({
  namespace: memoryNamespaceSchema.optional(),
  key: memoryKeySchema.optional(),
  type: z.nativeEnum(MemoryType).optional(),
  owner: memoryOwnerSchema.optional(),
  priority: z.nativeEnum(MemoryPriority).optional(),
  securityLevel: z.nativeEnum(MemorySecurityLevel).optional(),
  lifecycle: z.nativeEnum(MemoryLifecycleState).optional(),
});
