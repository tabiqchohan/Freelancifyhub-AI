import { z } from 'zod';

import { ToolCategory, ToolSecurityLevel } from '../enums/index.js';

/** Default storage backend. */
export const DEFAULT_TOOLS_STORAGE_BACKEND = 'in-memory';
/** Default: tools feature flag. */
export const DEFAULT_TOOLS_ENABLED = true;
/** Default execution timeout. */
export const DEFAULT_TOOLS_DEFAULT_TIMEOUT_MS = 5_000;
/** Default max input bytes. */
export const DEFAULT_TOOLS_MAX_INPUT_BYTES = 64 * 1024;
/** Default max output bytes. */
export const DEFAULT_TOOLS_MAX_OUTPUT_BYTES = 128 * 1024;
/** Default max retry count. */
export const DEFAULT_TOOLS_DEFAULT_RETRY_COUNT = 2;
/** Default max page size for repository pagination. */
export const DEFAULT_TOOLS_STORAGE_MAX_PAGE_SIZE = 50;
/** Default concurrency limit (advisory). */
export const DEFAULT_TOOLS_CONCURRENCY_LIMIT = 16;

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Typed runtime configuration for the Tool Manager. Fields are driven by
 * environment variables with safe defaults. No secrets are defined here.
 * The database URL is reused from the existing memory config when present
 * (never duplicated). Fail-closed: an unknown backend is rejected at parse.
 */
export const ToolConfigSchema = z.object({
  /** Feature flag: AG-004 tools subsystem. */
  TOOLS_ENABLED: booleanFromString.default(DEFAULT_TOOLS_ENABLED),
  /** Storage backend identifier. */
  TOOLS_STORAGE_BACKEND: z.string().min(1).default(DEFAULT_TOOLS_STORAGE_BACKEND),
  /** Reused database URL (shared with memory/knowledge when configured). */
  TOOLS_DATABASE_URL: z.string().optional(),
  /** Default execution timeout per tool. */
  TOOLS_DEFAULT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_TOOLS_DEFAULT_TIMEOUT_MS),
  /** Max input bytes per execution. */
  TOOLS_MAX_INPUT_BYTES: z.coerce.number().int().positive().default(DEFAULT_TOOLS_MAX_INPUT_BYTES),
  /** Max output bytes per execution. */
  TOOLS_MAX_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_TOOLS_MAX_OUTPUT_BYTES),
  /** Default retry count per execution. */
  TOOLS_DEFAULT_RETRY_COUNT: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_TOOLS_DEFAULT_RETRY_COUNT),
  /** Max page size for tool listing pagination. */
  TOOLS_STORAGE_MAX_PAGE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_TOOLS_STORAGE_MAX_PAGE_SIZE),
  /** Advisory default concurrency limit. */
  TOOLS_CONCURRENCY_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_TOOLS_CONCURRENCY_LIMIT),
});

export type ToolConfig = z.infer<typeof ToolConfigSchema>;

/** Default security level for tools. */
export const DEFAULT_TOOL_SECURITY_LEVEL: ToolSecurityLevel = ToolSecurityLevel.Internal;

/** Default category for unclassified tools. */
export const DEFAULT_TOOL_CATEGORY: ToolCategory = ToolCategory.Internal;

/** Default tool execution policy derived from config. */
export function defaultExecutionPolicy(config: ToolConfig): {
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  retryPolicy: { maxRetries: number; backoffBaseMs: number; backoffMaxMs: number };
  concurrencyLimit?: number;
  securityLevel: ToolSecurityLevel;
} {
  return {
    timeoutMs: config.TOOLS_DEFAULT_TIMEOUT_MS,
    maxInputBytes: config.TOOLS_MAX_INPUT_BYTES,
    maxOutputBytes: config.TOOLS_MAX_OUTPUT_BYTES,
    retryPolicy: {
      maxRetries: config.TOOLS_DEFAULT_RETRY_COUNT,
      backoffBaseMs: 50,
      backoffMaxMs: 500,
    },
    concurrencyLimit: config.TOOLS_CONCURRENCY_LIMIT,
    securityLevel: DEFAULT_TOOL_SECURITY_LEVEL,
  };
}
