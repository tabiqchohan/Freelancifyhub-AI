import { parseEnv } from '../src/config/env.js';

try {
  const env = parseEnv();
  console.info(`Environment configuration is valid (NODE_ENV=${env.NODE_ENV})`);
} catch (error) {
  console.error(`Invalid environment configuration: ${String(error)}`);
  process.exit(1);
}
