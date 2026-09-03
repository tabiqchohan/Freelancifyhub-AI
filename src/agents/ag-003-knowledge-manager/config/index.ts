import { KnowledgeConfigurationError } from '../errors/index.js';
import type { KnowledgeConfig } from './schema.js';
import { KnowledgeConfigSchema } from './schema.js';

/**
 * Parses and validates the knowledge configuration from a raw environment.
 */
export function parseKnowledgeConfig(raw: NodeJS.ProcessEnv = process.env): KnowledgeConfig {
  const result = KnowledgeConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new KnowledgeConfigurationError(`Invalid knowledge configuration:\n${issues}`);
  }

  return result.data;
}
