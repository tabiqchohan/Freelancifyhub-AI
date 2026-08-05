import type { ZodType } from 'zod';

import { ValidationError } from '../errors/index.js';

/**
 * Validates a value against a Zod schema and returns the parsed data, or
 * throws a {@link ValidationError} with normalised details. This is the single
 * validation entry point shared by every validator in the module.
 */
export function validateWithSchema<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    throw new ValidationError('Value failed schema validation', { details: { issues } });
  }

  return result.data;
}
