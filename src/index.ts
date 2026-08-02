import { env } from './config/index.js';
import { logger } from './lib/logger.js';
import { createAppServer } from './lib/server.js';

const server = createAppServer();

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Shutdown signal received, closing server');

  server.close((error) => {
    if (error) {
      logger.error({ error }, 'Failed to close server cleanly');
      process.exit(1);
    }

    logger.info('Server closed gracefully');
    process.exit(0);
  });
}

server.listen(env.PORT, env.HOST, () => {
  logger.info(
    `Freelancify AI foundation listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`,
  );
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
