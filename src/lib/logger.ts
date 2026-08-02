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

if (env.LOG_PRETTY) {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
    },
  };
}

export const logger: Logger = pino(options);
