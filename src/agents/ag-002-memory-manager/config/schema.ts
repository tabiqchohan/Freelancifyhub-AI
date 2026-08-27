import { z } from 'zod';

import { MemoryType } from '../enums/index.js';
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
/** Lifecycle/retention evaluation is enabled by default (Sprint 2, prompt §17). */
export const DEFAULT_MEMORY_LIFECYCLE_EVALUATION_ENABLED = true;
/** Cap on records evaluated per `runBatch` invocation (no global scheduler). */
export const DEFAULT_MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT = 100;
/** Context integration is enabled by default (Sprint 5A, prompt §11). */
export const DEFAULT_MEMORY_CONTEXT_INTEGRATION_ENABLED = true;
/** Default context budget (tokens) for the assembled context (prompt §5). */
export const DEFAULT_MEMORY_CONTEXT_MAX_TOKENS = 8192;
/** Default maximum number of generated context sections (prompt §11). */
export const DEFAULT_MEMORY_CONTEXT_MAX_SECTIONS = 8;
/** Default maximum records per context section (prompt §11). */
export const DEFAULT_MEMORY_CONTEXT_MAX_RECORDS_PER_SECTION = 20;
/** Default snippet length for records emitted into the context (prompt §11). */
export const DEFAULT_MEMORY_CONTEXT_SNIPPET_LENGTH = 200;
/** Memory consolidation is enabled by default (Sprint 5B, prompt §18). */
export const DEFAULT_MEMORY_CONSOLIDATION_ENABLED = true;
/** Minimum candidate records required to form a consolidation group. */
export const DEFAULT_MEMORY_CONSOLIDATION_MIN_RECORDS = 2;
/** Maximum records consolidated per operation (bounded, prompt §5). */
export const DEFAULT_MEMORY_CONSOLIDATION_MAX_RECORDS = 20;
/** Memory types eligible for consolidation by default (Sprint 5B, prompt §18). */
export const DEFAULT_MEMORY_CONSOLIDATION_ALLOWED_TYPES = [
  'CONVERSATION',
  'PROJECT',
  'WORKSPACE',
  'ORGANIZATION',
  'USER',
  'KNOWLEDGE_REFERENCE',
  'LONG_TERM',
] as const;

/** Default storage backend identifier (Sprint 6 — stays in-memory). */
export const DEFAULT_MEMORY_STORAGE_BACKEND = 'in-memory';
/** Default maximum page size for repository pagination (Sprint 6, prompt §4). */
export const DEFAULT_MEMORY_STORAGE_MAX_PAGE_SIZE = 50;

/** Default size limits shared by validation and config defaults. */
export const DEFAULT_MEMORY_LIMITS: MemorySizeLimits = {
  maxContentBytes: DEFAULT_MEMORY_MAX_CONTENT_BYTES,
  maxMetadataKeys: DEFAULT_MEMORY_MAX_METADATA_KEYS,
};

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

/** Comma-separated memory-type list (e.g. `"PROJECT,WORKSPACE"`) → enum array. */
const commaSeparatedMemoryTypes = z
  .string()
  .default(DEFAULT_MEMORY_CONSOLIDATION_ALLOWED_TYPES.join(','))
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(z.nativeEnum(MemoryType))); /**
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
  /** Feature flag: lifecycle/retention evaluation (Sprint 2, prompt §17). */
  MEMORY_LIFECYCLE_EVALUATION_ENABLED: booleanFromString.default(
    DEFAULT_MEMORY_LIFECYCLE_EVALUATION_ENABLED,
  ),
  /** Cap on records evaluated per lifecycle batch invocation (prompt §17, §20). */
  MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT),
  /** Feature flag: hybrid retrieval (spec §17). */
  MEMORY_HYBRID_SEARCH_ENABLED: booleanFromString,
  /** Feature flag: incremental summaries (spec §17). */
  MEMORY_INCREMENTAL_SUMMARY_ENABLED: booleanFromString,
  /** Feature flag: right-to-forget DSR erasure (spec §17). */
  MEMORY_RIGHT_TO_FORGET_ENABLED: booleanFromString,
  /** Feature flag: event-log replay recovery (spec §17). */
  MEMORY_EVENT_LOG_REPLAY_ENABLED: booleanFromString,
  /** Feature flag: context integration (Sprint 5A, prompt §11). */
  MEMORY_CONTEXT_INTEGRATION_ENABLED: booleanFromString.default(
    DEFAULT_MEMORY_CONTEXT_INTEGRATION_ENABLED,
  ),
  /** Context budget (tokens) enforced by the Context Integration Engine (prompt §5). */
  MEMORY_CONTEXT_MAX_TOKENS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_MEMORY_CONTEXT_MAX_TOKENS),
  /** Maximum number of context sections generated (prompt §11). */
  MEMORY_CONTEXT_MAX_SECTIONS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_CONTEXT_MAX_SECTIONS),
  /** Maximum records per context section (prompt §11). */
  MEMORY_CONTEXT_MAX_RECORDS_PER_SECTION: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_CONTEXT_MAX_RECORDS_PER_SECTION),
  /** Snippet length for records emitted into the context (prompt §11). */
  MEMORY_CONTEXT_SNIPPET_LENGTH: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_CONTEXT_SNIPPET_LENGTH),
  /** Feature flag: memory consolidation (Sprint 5B, prompt §18). */
  MEMORY_CONSOLIDATION_ENABLED: booleanFromString.default(DEFAULT_MEMORY_CONSOLIDATION_ENABLED),
  /** Minimum candidate records required to form a consolidation group. */
  MEMORY_CONSOLIDATION_MIN_RECORDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_CONSOLIDATION_MIN_RECORDS),
  /** Maximum records consolidated per operation (prompt §5). */
  MEMORY_CONSOLIDATION_MAX_RECORDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_CONSOLIDATION_MAX_RECORDS),
  /** Memory types eligible for consolidation (comma-separated, prompt §18). */
  MEMORY_CONSOLIDATION_ALLOWED_TYPES: commaSeparatedMemoryTypes,
  /** Storage backend identifier (Sprint 6). Default must stay `in-memory`. */
  MEMORY_STORAGE_BACKEND: z.string().min(1).default(DEFAULT_MEMORY_STORAGE_BACKEND),
  /** Maximum page size for repository pagination (validated, prompt §4). */
  MEMORY_STORAGE_MAX_PAGE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MEMORY_STORAGE_MAX_PAGE_SIZE),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
