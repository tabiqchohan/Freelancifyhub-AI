/**
 * Sprint 26 — AIOS schema-bounded input validation (fail-closed).
 *
 * Validates and bounds inbound requests before any orchestration happens.
 * Nothing user-supplied reaches an agent without passing through this gate.
 */

import { z } from 'zod';
import type { AiosConfig } from './config.js';
import { AiosError, AiosErrorCode } from './errors.js';
import type { AiosInput } from './types.js';

/** Bounded JSON value with an explicit depth ceiling. */
const boundedJson = z.unknown().refine(() => true, {
  message: 'structured input must be valid JSON',
});

/** Non-empty, trimmed text bounded by the configured ceiling. */
function textSchema(config: AiosConfig): z.ZodString {
  return z
    .string()
    .min(1, 'text must not be empty')
    .max(config.AIOS_MAX_TEXT_LENGTH, `text exceeds ${config.AIOS_MAX_TEXT_LENGTH} characters`);
}

/**
 * Validates the inbound input object. Returns the trimmed, scaffolded input or
 * throws {@link AiosError} for malformed/oversized payloads. Structured input
 * depth and byte size are hard-bounded (fail-closed).
 */
export function validateAiosInput(input: unknown, config: AiosConfig): AiosInput {
  const parsed = z
    .object({
      text: z.string(),
      structured: boundedJson.optional(),
    })
    .safeParse(input);

  if (!parsed.success) {
    throw new AiosError(AiosErrorCode.InvalidInput, 'Invalid AIOS request input', {
      details: { issues: parsed.error.issues.map((i) => i.message) },
    });
  }

  const textResult = textSchema(config).safeParse(parsed.data.text.trim());
  if (!textResult.success) {
    throw new AiosError(AiosErrorCode.PayloadTooLarge, 'Inbound text exceeds the AIOS size limit', {
      details: { max: config.AIOS_MAX_TEXT_LENGTH },
    });
  }

  let structured: Readonly<Record<string, unknown>> | undefined;
  if (parsed.data.structured !== undefined) {
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data.structured), 'utf8');
    if (bytes > config.AIOS_STRUCTURED_MAX_BYTES) {
      throw new AiosError(
        AiosErrorCode.PayloadTooLarge,
        'Structured input exceeds the AIOS byte limit',
        { details: { max: config.AIOS_STRUCTURED_MAX_BYTES, bytes } },
      );
    }
    if (JSON.stringify(parsed.data.structured).length > config.AIOS_STRUCTURED_HARD_LIMIT_BYTES) {
      throw new AiosError(
        AiosErrorCode.PayloadTooLarge,
        'Structured input exceeds the AIOS hard byte limit',
      );
    }
    structured = parsed.data.structured as Readonly<Record<string, unknown>>;
  }

  return {
    text: textResult.data,
    structured,
  };
}

/** Bounds the per-request timeout knob (min 1 ms, max config ceiling). */
export function normalizeTimeoutMs(raw: number | undefined, config: AiosConfig): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return config.AIOS_REQUEST_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(Math.floor(raw), config.AIOS_REQUEST_TIMEOUT_MS));
}
