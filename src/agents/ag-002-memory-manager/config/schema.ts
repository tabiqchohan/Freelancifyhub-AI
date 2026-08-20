import { z } from 'zod';

import type { MemorySizeLimits } from '../types/index.js';

/** Default conversation retention window (spec §17: 30 days). */
export const DEFAULT_MEMORY_TTL_CONVERSATION_MS = 30 * 24 * 60 * 60 * 1000;
/** Default temporary scratch TTL (spec §17: 15 minutes). */
export const DEFAULT_MEMORY_TTL_TEMPORARY_MS = 15 * 60 * 1000;
/** Default project archive window (spec §17: 90 days). */
export const DEFAULT_MEMORY_RETENTION_PROJECT_ARCHIVE_MS = 90 * 24 * 60 * 60 * 1000;
/** Default per-record content cap (64 KB, spec §4 short-term limit). */
export const DEFAULT_MEMORY_MAX_CONTENT_BYTES = 64 * 1024;
/** Default metadata key cap (bounded metadata, spec §27). */
export const DEFAULT_MEMORY_MAX_METADATA_KEYS = 64;
/** Default retrieval result cap (spec §8, §15). */
export const DEFAULT_MEMORY_RETRIEVAL_MAX_RESULTS = 50;

/** Default size limits shared by validation and config defaults. */
export const DEFAULT_MEMORY_LIMITS: MemorySizeLimits = {
  maxContentBytes: DEFAULT_MEMORY_MAX_CONTENT_BYTES,
  maxMetadataKeys: DEFAULT_MEMORY_MAX_METADATA_KEYS,
};

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

/**
 * Typed runtime configuration for the Memory Manager (spec §17). Fields are
 * driven by environment variables with safe defaults. No secrets are defined
 * here. Keys map to the architecture dot-style settings:
 * `memory.ttl.conversation` → `MEMORY_TTL_CONVERSATION_MS`, etc.
 */
export const MemoryConfigSchema = z.object({
  /** Conversation retention window (spec §17 `memory.ttl.conversation`). */
  MEMORY_TTL_CONVERSATION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_TTL_CONVERSATION_MS),
  /** Temporary scratch TTL (spec §17 `memory.ttl.temporary`). */
  MEMORY_TTL_TEMPORARY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_TTL_TEMPORARY_MS),
  /** Project archive window (spec §17 `memory.retention.projectArchive`). */
  MEMORY_RETENTION_PROJECT_ARCHIVE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_RETENTION_PROJECT_ARCHIVE_MS),
  /** Maximum serialized content bytes per record (spec §27). */
  MEMORY_MAX_CONTENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_MAX_CONTENT_BYTES),
  /** Maximum metadata keys per record (spec §27). */
  MEMORY_MAX_METADATA_KEYS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_MAX_METADATA_KEYS),
  /** Maximum results returned by a retrieval query (spec §15). */
  MEMORY_RETRIEVAL_MAX_RESULTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_RETRIEVAL_MAX_RESULTS),
  /** Feature flag: hybrid retrieval (spec §17). */
  MEMORY_HYBRID_SEARCH_ENABLED: booleanFromString,
  /** Feature flag: incremental summaries (spec §17). */
  MEMORY_INCREMENTAL_SUMMARY_ENABLED: booleanFromString,
  /** Feature flag: right-to-forget DSR erasure (spec §17). */
  MEMORY_RIGHT_TO_FORGET_ENABLED: booleanFromString,
  /** Feature flag: event-log replay recovery (spec §17). */
  MEMORY_EVENT_LOG_REPLAY_ENABLED: booleanFromString,
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
