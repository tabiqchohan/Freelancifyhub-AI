import { OrchestratorConfigSchema } from '../config/schema.js';
import type { OrchestratorConfig } from '../config/schema.js';
import { validateWithSchema } from '../utils/schema.js';

/** Validates flat configuration values against the orchestrator config schema. */
export function validateOrchestratorConfig(input: unknown): OrchestratorConfig {
  return validateWithSchema(OrchestratorConfigSchema, input);
}
