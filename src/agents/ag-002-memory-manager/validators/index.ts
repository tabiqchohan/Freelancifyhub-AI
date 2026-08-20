import { DEFAULT_MEMORY_LIMITS } from '../config/schema.js';
import {
  MemoryActorGroup,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../enums/index.js';
import { MemoryValidationError } from '../errors/index.js';
import {
  memoryContentSchema,
  memoryIdSchema,
  memoryKeySchema,
  memoryMetadataSchema,
  memoryNamespaceSchema,
  memoryOwnerSchema,
  memoryRecordFilterSchema,
  memoryRecordSchema,
} from '../schemas/index.js';
import type { MemoryActor } from '../security/index.js';
import type {
  IsoTimestamp,
  MemoryContent,
  MemoryId,
  MemoryKey,
  MemoryMetadata,
  MemoryNamespace,
  MemoryOwner,
  MemoryRecord,
  MemoryRecordFilter,
  MemorySizeLimits,
} from '../types/index.js';
import { validateWithSchema } from '../utils/schema.js';
import { z } from 'zod';

const memoryActorSchema = z.object({
  group: z.nativeEnum(MemoryActorGroup),
  id: z.string().min(1).optional(),
  namespaces: z.array(memoryNamespaceSchema).optional(),
});

const memoryReason = z.string().min(1).max(1024);
const memoryTraceId = z.string().min(1);
const nonNegativeInt = z.number().int().min(0);
const positiveInt = z.number().int().positive();

/** Validates a memory record id. */
export function validateMemoryId(input: unknown): MemoryId {
  return validateWithSchema(memoryIdSchema, input);
}

/** Validates a memory type. */
export function validateMemoryType(input: unknown): MemoryType {
  return validateWithSchema(z.nativeEnum(MemoryType), input);
}

/** Validates a memory priority. */
export function validateMemoryPriority(input: unknown): MemoryPriority {
  return validateWithSchema(z.nativeEnum(MemoryPriority), input);
}

/** Validates a memory security level. */
export function validateMemorySecurityLevel(input: unknown): MemorySecurityLevel {
  return validateWithSchema(z.nativeEnum(MemorySecurityLevel), input);
}

/** Validates a memory version (positive integer). */
export function validateMemoryVersion(input: unknown): number {
  return validateWithSchema(positiveInt, input);
}

/** Validates a namespace (`scope:value`). */
export function validateMemoryNamespace(input: unknown): MemoryNamespace {
  return validateWithSchema(memoryNamespaceSchema, input);
}

/** Validates a logical key. */
export function validateMemoryKey(input: unknown): MemoryKey {
  return validateWithSchema(memoryKeySchema, input);
}

/** Validates a memory owner. */
export function validateMemoryOwner(input: unknown): MemoryOwner {
  return validateWithSchema(memoryOwnerSchema, input);
}

/** Validates a memory actor (access-control subject). */
export function validateMemoryActor(input: unknown): MemoryActor {
  return validateWithSchema(memoryActorSchema, input);
}

/** Validates memory content (recursive JSON value). */
export function validateMemoryContent(input: unknown): MemoryContent {
  return validateWithSchema(memoryContentSchema, input);
}

/** Validates memory metadata (JSON key-value record). */
export function validateMemoryMetadata(input: unknown): MemoryMetadata {
  return validateWithSchema(memoryMetadataSchema, input);
}

/** Validates a non-negative TTL in milliseconds (0 = no expiry). */
export function validateTtlMs(input: unknown): number {
  return validateWithSchema(nonNegativeInt, input);
}

/** Validates a record filter (retrieval/repository listing). */
export function validateMemoryRecordFilter(input: unknown): MemoryRecordFilter {
  return validateWithSchema(memoryRecordFilterSchema, input);
}

/** Validates a write reason (AC-MEM-3: every write carries a reason). */
export function validateReason(input: unknown): string {
  return validateWithSchema(memoryReason, input);
}

/** Validates a trace id. */
export function validateTraceId(input: unknown): string {
  return validateWithSchema(memoryTraceId, input);
}

/**
 * Validates TTL cross-consistency: timestamps must be valid, and when both a
 * TTL and an expiry are present they must agree (expiry = created + ttl).
 * Returns the normalized values.
 */
export function validateTtl(input: {
  readonly createdAt: unknown;
  readonly expiresAt?: unknown;
  readonly ttlMs?: unknown;
}): { readonly expiresAt?: IsoTimestamp; readonly ttlMs?: number } {
  const createdAt = validateWithSchema(
    z.string().refine((value) => Number.isFinite(Date.parse(value)), 'expected a valid timestamp'),
    input.createdAt,
  );

  let ttlMs: number | undefined;
  if (input.ttlMs !== undefined) {
    ttlMs = validateTtlMs(input.ttlMs);
  }

  let expiresAt: IsoTimestamp | undefined;
  if (input.expiresAt !== undefined) {
    expiresAt = validateWithSchema(
      z
        .string()
        .refine((value) => Number.isFinite(Date.parse(value)), 'expected a valid timestamp'),
      input.expiresAt,
    );
  }

  if (ttlMs !== undefined && expiresAt !== undefined) {
    const diff = new Date(expiresAt).getTime() - new Date(createdAt).getTime();
    if (diff !== ttlMs) {
      throw new MemoryValidationError('TTL and expiresAt are inconsistent', {
        details: { ttlMs, createdDeltaMs: diff },
      });
    }
  }

  return { ttlMs, expiresAt };
}

/**
 * Validates a full memory record: structural schema, size limits (spec §17,
 * §27) and TTL consistency. Never mutates the input.
 */
export function validateMemoryRecord(
  input: unknown,
  limits: MemorySizeLimits = DEFAULT_MEMORY_LIMITS,
): MemoryRecord {
  const parsed = validateWithSchema(memoryRecordSchema, input);

  const contentBytes = Buffer.byteLength(JSON.stringify(parsed.content), 'utf8');
  if (contentBytes > limits.maxContentBytes) {
    throw new MemoryValidationError('Memory content exceeds the configured size limit', {
      details: { contentBytes, maxContentBytes: limits.maxContentBytes },
    });
  }

  const metadataKeys = Object.keys(parsed.metadata).length;
  if (metadataKeys > limits.maxMetadataKeys) {
    throw new MemoryValidationError('Memory metadata exceeds the configured key limit', {
      details: { metadataKeys, maxMetadataKeys: limits.maxMetadataKeys },
    });
  }

  validateTtl({
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    ttlMs: parsed.ttlMs,
  });

  return parsed;
}
