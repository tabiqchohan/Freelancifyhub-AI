export { EnvSchema, parseEnv } from './env.js';
export type { Env } from './env.js';

import { parseEnv } from './env.js';
import type { Env } from './env.js';

export const env: Env = parseEnv();
