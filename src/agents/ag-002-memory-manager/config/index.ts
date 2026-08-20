import { MemoryConfigurationError } from '../errors/index.js';
import type { MemoryConfig } from './schema.js';
import { MemoryConfigSchema } from './schema.js';

/**
 * Parses and validates the memory configuration from a raw environment,
 * returning a typed value or throwing a {@link MemoryConfigurationError}.
 */
export function parseMemoryConfig(raw: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const result = MemoryConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new MemoryConfigurationError(`Invalid memory configuration:\n${issues}`);
  }

  return result.data;
}

/** The parsed memory configuration for the running process. */
export const memoryConfig: MemoryConfig = parseMemoryConfig();
