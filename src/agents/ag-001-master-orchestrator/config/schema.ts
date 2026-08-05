import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

/**
 * Typed runtime configuration for the Master Orchestrator. Fields are driven
 * by environment variables with safe defaults. No secrets are defined here.
 */
export const OrchestratorConfigSchema = z.object({
  ORCHESTRATOR_NAME: z.string().min(1).default('master-orchestrator'),
  ORCHESTRATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  ORCHESTRATOR_LONG_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  ORCHESTRATOR_RETRY_MAX: z.coerce.number().int().min(0).max(10).default(3),
  ORCHESTRATOR_RETRY_BASE_MS: z.coerce.number().int().min(0).default(500),
  ORCHESTRATOR_APPROVAL_GATE: booleanFromString,
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
