import { z } from 'zod';

import { ContextBudgetError } from '../errors/index.js';
import type { ContextOverflowBehavior } from '../types/index.js';
import { ContextSectionType } from '../types/index.js';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const overflowFromString = z
  .enum(['truncate', 'fail'])
  .default('truncate')
  .transform((value): ContextOverflowBehavior => value);

const sectionOrderFromString = z
  .string()
  .default('system,request,user,project,conversation,memory,knowledge,tool,agent')
  .transform((value): readonly ContextSectionType[] => {
    const sections = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0) as ContextSectionType[];

    return sections;
  });

/**
 * Typed configuration for the context builder engine. Values are driven by
 * environment variables with safe defaults; nothing here is secret.
 */
export const ContextConfigSchema = z.object({
  CONTEXT_VERSION: z.string().min(1).default('context.v1'),
  CONTEXT_MAX_TOKENS: z.coerce.number().int().positive().default(8000),
  CONTEXT_RESERVED_TOKENS: z.coerce.number().int().min(0).default(200),
  CONTEXT_MIN_TOKENS: z.coerce.number().int().min(0).default(200),
  CONTEXT_WARNING_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  CONTEXT_OVERFLOW_BEHAVIOR: overflowFromString,
  CONTEXT_DEDUPLICATION_ENABLED: booleanFromString,
  CONTEXT_COMPRESSION_ENABLED: booleanFromString,
  CONTEXT_SECTION_ORDER: sectionOrderFromString,
});

export type ContextConfig = z.infer<typeof ContextConfigSchema>;

function assertBudgetConsistency(config: ContextConfig): void {
  if (config.CONTEXT_RESERVED_TOKENS >= config.CONTEXT_MAX_TOKENS) {
    throw new ContextBudgetError(
      `Reserved tokens (${config.CONTEXT_RESERVED_TOKENS}) must be below max tokens (${config.CONTEXT_MAX_TOKENS})`,
    );
  }

  if (config.CONTEXT_MIN_TOKENS > config.CONTEXT_MAX_TOKENS - config.CONTEXT_RESERVED_TOKENS) {
    throw new ContextBudgetError(
      `Min tokens (${config.CONTEXT_MIN_TOKENS}) exceeds usable budget ` +
        `(${config.CONTEXT_MAX_TOKENS} - ${config.CONTEXT_RESERVED_TOKENS})`,
    );
  }
}

/** Parses and validates the context configuration from a raw environment. */
export function parseContextConfig(raw: NodeJS.ProcessEnv = process.env): ContextConfig {
  const result = ContextConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new ContextBudgetError(`Invalid context configuration:\n${issues}`);
  }

  assertBudgetConsistency(result.data);
  return result.data;
}

/** The parsed context configuration for the running process. */
export const contextConfig: ContextConfig = parseContextConfig();

export { ContextSectionType };
