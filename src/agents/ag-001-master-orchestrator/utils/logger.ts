import type { Logger } from 'pino';

import { logger } from '../../../lib/logger.js';

/**
 * Creates a scoped child logger for the Master Orchestrator renaming reuse of
 * the existing pino infrastructure (no duplicate logger). Each child inherits
 * the shared `service` field and adds agent-level fields for filtering.
 */
export function createOrchestratorLogger(name: string): Logger {
  return logger.child({ name });
}
