/**
 * Sprint 26 — AIOS configuration. Fail-closed: invalid env aborts construction.
 *
 * Every limit and knob is typed and bounded. Agent code never observes these
 * values directly; they are consumed only by the AIOS boundary.
 */

import { z } from 'zod';
import type { Environment } from '../app/env.js';

export const AiosConfigSchema = z.object({
  /** Hard ceiling on inbound `text` length (characters). */
  AIOS_MAX_TEXT_LENGTH: z.coerce.number().int().positive().default(20_000),
  /** Maximum allowed depth of structured input JSON. */
  AIOS_STRUCTURED_DEPTH: z.coerce.number().int().positive().max(20).default(6),
  /** Maximum serialised byte size of structured input. */
  AIOS_STRUCTURED_MAX_BYTES: z.coerce.number().int().positive().default(131_072),
  /** Per-request execution timeout (ms). */
  AIOS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Enable inbound secret scanning at the boundary. */
  AIOS_SECRET_SCAN_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Number of recent AIOS events retained in the ring buffer. */
  AIOS_EVENT_WINDOW: z.coerce.number().int().positive().default(200),
  /** Deduplication window for idempotency keys (ms). */
  AIOS_IDEMPOTENCY_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  /** Absolute ceiling on structured input depth (hard-fail, never soft-cap). */
  AIOS_STRUCTURED_HARD_LIMIT_BYTES: z.coerce.number().int().positive().default(262_144),
});

export type AiosConfig = z.infer<typeof AiosConfigSchema>;

export const DEFAULT_AIOS_CONFIG: AiosConfig = {
  AIOS_MAX_TEXT_LENGTH: 20_000,
  AIOS_STRUCTURED_DEPTH: 6,
  AIOS_STRUCTURED_MAX_BYTES: 131_072,
  AIOS_REQUEST_TIMEOUT_MS: 60_000,
  AIOS_SECRET_SCAN_ENABLED: true,
  AIOS_EVENT_WINDOW: 200,
  AIOS_IDEMPOTENCY_WINDOW_MS: 300_000,
  AIOS_STRUCTURED_HARD_LIMIT_BYTES: 262_144,
};

/**
 * Parses AIOS config from the process environment. Unknown keys are silently
 * ignored; missing keys use safe defaults. Throws on obviously invalid values.
 */
export function parseAiosConfig(raw: NodeJS.ProcessEnv = process.env): AiosConfig {
  const result = AiosConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid AIOS configuration:\n${issues}`);
  }
  return result.data;
}

/**
 * Builds AIOS config from the composition root's environment. This is the
 * composition-time entry point; runtime code uses {@link DEFAULT_AIOS_CONFIG}
 * or reads the parsed value from the composition.
 */
export function buildAiosConfig(_env: Environment): AiosConfig {
  return parseAiosConfig(process.env);
}
