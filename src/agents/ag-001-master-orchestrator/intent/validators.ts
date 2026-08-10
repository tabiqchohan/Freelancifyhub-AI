import { z } from 'zod';

import { IntentValidationError } from './errors.js';
import { IntentId, UserRole, type IntentDefinition, type IntentResult } from './types.js';

/** Validates that classification input is a non-blank string (prompt §8). */
export function validateIntentInput(input: unknown): asserts input is string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new IntentValidationError('Intent input must be a non-empty string');
  }
}

const intentResultSchema = z.object({
  primary: z.object({
    intent: z.object({ id: z.string().min(1) }),
    confidence: z.number().min(0).max(1),
    matchedKeywords: z.array(z.string()),
    matchedRules: z.array(z.string()),
  }),
  secondary: z.array(z.unknown()),
  candidates: z.array(z.unknown()),
  confidence: z.number().min(0).max(1),
  matchedKeywords: z.array(z.string()),
  matchedRules: z.array(z.string()),
  fallback: z.boolean(),
  fallbackReason: z.string().optional(),
  metadata: z.object({
    classifier: z.string().min(1),
    version: z.string().min(1),
    detectedAt: z.string().min(1),
    inputLength: z.number().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    thresholds: z.object({
      high: z.number().min(0).max(1),
      low: z.number().min(0).max(1),
    }),
  }),
});

/** Validates the shape of a produced classification result (prompt §8). */
export function validateIntentResult(input: unknown): IntentResult {
  const parsed = intentResultSchema.safeParse(input);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new IntentValidationError(`Invalid intent result:\n${issues}`);
  }

  return parsed.data as unknown as IntentResult;
}

/** Validates an intent definition (prompt §8: ids, roles, threshold). */
export function validateIntentDefinition(definition: IntentDefinition): void {
  if (!Object.values(IntentId).includes(definition.id)) {
    throw new IntentValidationError(`Unknown intent id: ${definition.id}`);
  }

  if (definition.name.trim().length === 0) {
    throw new IntentValidationError(`Intent ${definition.id} has an empty name`);
  }

  if (definition.confidenceThreshold < 0 || definition.confidenceThreshold > 1) {
    throw new IntentValidationError(
      `Intent ${definition.id} confidence threshold out of range [0,1]`,
    );
  }

  for (const role of definition.allowedRoles) {
    if (!Object.values(UserRole).includes(role)) {
      throw new IntentValidationError(`Intent ${definition.id} has unknown role: ${role}`);
    }
  }
}
