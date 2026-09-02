import { env } from './config/index.js';
import { logger } from './lib/logger.js';
import { createProductionComposition } from './app/composition-root.js';
import { createProductionRuntime } from './app/runtime.js';
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
    try {
      await runtime.shutdown();
      logger.info('Server closed gracefully');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Failed to close server cleanly');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
