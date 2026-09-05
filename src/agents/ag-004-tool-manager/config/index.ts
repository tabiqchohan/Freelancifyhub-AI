import { ToolConfigurationError } from '../errors/index.js';
import type { ToolConfig } from './schema.js';
import { ToolConfigSchema } from './schema.js';

export { ToolConfigSchema };
export type { ToolConfig };

/**
 * Parses and validates the tool configuration from a raw environment.
 * Fail-closed: invalid values throw a ToolConfigurationError.
 */
export function parseToolConfig(raw: NodeJS.ProcessEnv = process.env): ToolConfig {
  const result = ToolConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new ToolConfigurationError(`Invalid tool configuration:\n${issues}`);
  }

  return result.data;
}
