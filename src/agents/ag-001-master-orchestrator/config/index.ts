import { ConfigurationError } from '../errors/index.js';
import type { OrchestratorConfig } from './schema.js';
import { OrchestratorConfigSchema } from './schema.js';

/**
 * Parses and validates the orchestrator configuration from a raw environment,
 * returning a typed value or throwing a {@link ConfigurationError}.
 */
export function parseOrchestratorConfig(raw: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const result = OrchestratorConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new ConfigurationError(`Invalid orchestrator configuration:\n${issues}`);
  }

  return result.data;
}

/** The parsed orchestrator configuration for the running process. */
export const orchestratorConfig: OrchestratorConfig = parseOrchestratorConfig();
