import { env } from './config/index.js';
import { logger } from './lib/logger.js';
import { createProductionComposition } from './app/composition-root.js';
import { createProductionRuntime, SHUTDOWN_DRAIN_TIMEOUT_MS } from './app/runtime.js';
import { DiagnosticError } from './app/errors.js';

async function main(): Promise<void> {
  logger.info('booting production composition root');

  let composition;
  try {
    composition = await createProductionComposition({ logger });
  } catch (error) {
    if (error instanceof DiagnosticError) {
      logger.fatal({ code: error.code, message: error.message }, 'composition root failed');
    } else {
      logger.fatal({ error }, 'composition root failed unexpectedly');
    }
    process.exit(1);
    return;
  }

  const runtime = createProductionRuntime({ composition, logger });

  try {
    await runtime.start(env.PORT, env.HOST);
  } catch (error) {
    logger.fatal({ error }, 'failed to start runtime server');
    process.exit(1);
    return;
  }

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received, closing runtime');
    // Prompts15 Phase 9: never let a stuck socket hold the process past the
    // orchestrator's grace window. If the drain has not completed in time, exit
    // anyway - the supervisor will restart the instance, which is preferable to
    // being SIGKILLed and reported as an unclean shutdown.
    const forceTimer = setTimeout(() => {
      logger.error(
        { signal, drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
        'Graceful shutdown exceeded its drain window; exiting',
      );
      process.exit(1);
    }, SHUTDOWN_DRAIN_TIMEOUT_MS + 5_000);
    forceTimer.unref();
    try {
      await runtime.shutdown({ drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS });
      clearTimeout(forceTimer);
      logger.info('Server closed gracefully');
      process.exit(0);
    } catch (error) {
      clearTimeout(forceTimer);
      logger.error({ error }, 'Failed to close server cleanly');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Sprint 34 — never let an unhandled rejection silently kill the process or
  // vanish into the void. Log the bounded summary and continue; the process
  // stays up so healthy requests still drain.
  process.on('unhandledRejection', (reason) => {
    logger.error(boundedRejection(reason), 'unhandled promise rejection');
  });
}

void main();

/** Safe, bounded summary of a rejected value (never raw `String(reason)`). */
function boundedRejection(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return { name: reason.name, message: truncate(reason.message, 500) };
  }
  return { name: 'rejection', message: truncate(String(reason), 500) };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
