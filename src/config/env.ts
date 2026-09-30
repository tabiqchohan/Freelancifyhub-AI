import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv({ path: process.env.ENV_FILE ?? '.env' });

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanFromString,
  /**
   * Shared server-to-server token. Every inbound request that reaches a business
   * endpoint MUST present it via the `x-aios-service-token` header (fail-closed).
   * Business endpoints are all paths except the liveness probes (`/health`,
   * `/healthz`). Sprint 35 F-4: when empty the runtime DENIES every business
   * endpoint — it no longer silently opens up. Local development must opt in
   * explicitly with `AIOS_ALLOW_UNAUTHENTICATED=true`, which is ignored in
   * production.
   */
  AIOS_SERVICE_TOKEN: z.string().max(512).default(''),
  /**
   * Sprint 35 F-4 — dedicated credential for *management* operations
   * (AG-004 tool enable/disable, registry management). Presented via the
   * `x-aios-admin-token` header. Fail-closed: management endpoints are denied
   * outright when no admin token is configured, so they can never be reached by
   * naming an actor group in the query string. Ignored in production unless set.
   */
  AIOS_ADMIN_TOKEN: z.string().max(512).default(''),
  /**
   * Sprint 35 F-4 — explicit opt-in for running the business API without any
   * service token. Default `false` (fail-closed). Always ignored when
   * `NODE_ENV=production`, so it cannot weaken a production deployment.
   */
  AIOS_ALLOW_UNAUTHENTICATED: booleanFromString,
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
