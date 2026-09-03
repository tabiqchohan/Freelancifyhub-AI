import { z } from 'zod';

/** Default max content bytes per knowledge document. */
export const DEFAULT_KNOWLEDGE_MAX_CONTENT_BYTES = 512 * 1024;
/** Default max metadata keys per document. */
export const DEFAULT_KNOWLEDGE_MAX_METADATA_KEYS = 64;
/** Default max title length. */
export const DEFAULT_KNOWLEDGE_MAX_TITLE_LENGTH = 500;
/** Default max retrieval results. */
export const DEFAULT_KNOWLEDGE_RETRIEVAL_MAX_RESULTS = 50;
/** Default chunk max size. */
export const DEFAULT_KNOWLEDGE_CHUNK_MAX_SIZE = 1000;
/** Default chunk overlap size. */
export const DEFAULT_KNOWLEDGE_CHUNK_OVERLAP_SIZE = 100;
/** Default storage backend. */
export const DEFAULT_KNOWLEDGE_STORAGE_BACKEND = 'in-memory';
/** Default max page size for repository pagination. */
export const DEFAULT_KNOWLEDGE_STORAGE_MAX_PAGE_SIZE = 50;

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Typed runtime configuration for the Knowledge Manager.
 */
export const KnowledgeConfigSchema = z.object({
  /** Max content bytes per document. */
  KNOWLEDGE_MAX_CONTENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_KNOWLEDGE_MAX_CONTENT_BYTES),
  /** Max metadata keys per document. */
  KNOWLEDGE_MAX_METADATA_KEYS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_KNOWLEDGE_MAX_METADATA_KEYS),
  /** Max title length. */
  KNOWLEDGE_MAX_TITLE_LENGTH: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_KNOWLEDGE_MAX_TITLE_LENGTH),
  /** Max retrieval results. */
  KNOWLEDGE_RETRIEVAL_MAX_RESULTS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_KNOWLEDGE_RETRIEVAL_MAX_RESULTS),
  /** Chunk max size. */
  KNOWLEDGE_CHUNK_MAX_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_KNOWLEDGE_CHUNK_MAX_SIZE),
  /** Chunk overlap size. */
  KNOWLEDGE_CHUNK_OVERLAP_SIZE: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_KNOWLEDGE_CHUNK_OVERLAP_SIZE),
  /** Feature flag: knowledge context integration. */
  KNOWLEDGE_CONTEXT_ENABLED: booleanFromString.default(true),
  /** Storage backend identifier. */
  KNOWLEDGE_STORAGE_BACKEND: z.string().min(1).default(DEFAULT_KNOWLEDGE_STORAGE_BACKEND),
  /** Max page size for pagination. */
  KNOWLEDGE_STORAGE_MAX_PAGE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_KNOWLEDGE_STORAGE_MAX_PAGE_SIZE),
  /** PostgreSQL connection string. Optional; mandatory when backend=durable. */
  KNOWLEDGE_DATABASE_URL: z.string().optional(),
});

export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>;
