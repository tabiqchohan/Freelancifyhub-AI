/**
 * Orchestration configuration. The AG-001 runtime configuration already owns
 * the timeout/retry/approval settings, so this module re-exports it instead of
 * duplicating values (prompt §18).
 */
export { OrchestratorConfigSchema } from '../../config/schema.js';
export type { OrchestratorConfig } from '../../config/schema.js';
export { parseOrchestratorConfig, orchestratorConfig } from '../../config/index.js';
