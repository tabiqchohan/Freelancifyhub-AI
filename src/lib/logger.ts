import { pino } from 'pino';
import type { Logger, LoggerOptions } from 'pino';

import { env } from '../config/index.js';

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: {
    service: 'freelancify-ai',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * Prompts15 Phase 6/10 — `LOG_PRETTY` must never break a production container.
 *
 * `pino-pretty` is a **devDependency**, and the Dockerfile runs
 * `npm prune --omit=dev`, so the final runtime image does not contain it. If a
 * production deployment set `LOG_PRETTY=true`, pino would try to load a missing
 * transport target and the logger would fail to initialise at boot — taking the
 * whole service down before it ever bound its port.
 *
 * The guard is fail-safe rather than fail-closed on purpose: pretty logging is a
 * developer convenience, so silently degrading to structured JSON in production
 * is strictly better than refusing to start. It is additionally forced off when
 * `NODE_ENV=production`, which the Dockerfile also sets.
 */
const prettyRequested = env.LOG_PRETTY;
const isProduction = env.NODE_ENV === 'production';

if (prettyRequested && !isProduction) {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
    },
  };
}

if (prettyRequested && isProduction) {
  // Never log a secret; this is a configuration fact only.
  process.stderr.write(
    '[freelancify-ai] LOG_PRETTY is enabled but NODE_ENV=production; ' +
      'using structured JSON logs (pino-pretty is a dev-only dependency).\n',
  );
}

export const logger: Logger = pino(options);
