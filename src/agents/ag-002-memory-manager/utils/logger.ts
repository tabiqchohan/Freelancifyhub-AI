import type { Logger } from 'pino';

import { logger } from '../../../lib/logger.js';

/**
 * Creates a scoped child logger for the Memory Manager (spec §21: `agent=AG-002`).
 * Reuses the existing pino infrastructure (no duplicate logger). Never log
 * memory content through this logger — use {@link sanitizeMemoryRecordForLogs}.
 */
export function createMemoryLogger(name: string): Logger {
  return logger.child({ name, agent: 'AG-002' });
}
