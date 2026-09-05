import type { z } from 'zod';

import type { ToolSchema } from '../types/index.js';
import { ToolValidationError } from '../errors/index.js';

/**
 * AG-004 schema validation. Input and output are validated with zod (the
 * project's existing validation library). Schemas are compiled once per tool
 * (on construction) to avoid repeated compilation overhead.
 */

/** Result of a validation attempt. */
export interface ToolValidationResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly issues?: readonly string[];
  readonly code?: string;
}

/** Compiles a schema once (cached) so repeated validations don't re-compile. */
export class ToolInputValidator {
  readonly name = 'tool-input-validator';
  private readonly schema: ToolSchema;

  constructor(schema: ToolSchema) {
    this.schema = schema;
  }

  /** Validates raw input against the tool's input schema. */
  validate(input: unknown): ToolValidationResult {
    try {
      const result = (this.schema as z.ZodType).safeParse(input);
      if (!result.success) {
        return {
          ok: false,
          issues: result.error.issues.map((i) => i.message),
          code: 'INPUT_VALIDATION_FAILED',
        };
      }
      return { ok: true, value: result.data };
    } catch (cause) {
      throw new ToolValidationError('Unexpected failure validating tool input', {
        code: 'INPUT_VALIDATION_ERROR',
        cause,
      });
    }
  }
}

/** Compiles a schema once (cached) so repeated validations don't re-compile. */
export class ToolOutputValidator {
  readonly name = 'tool-output-validator';
  private readonly schema: ToolSchema;

  constructor(schema: ToolSchema) {
    this.schema = schema;
  }

  /** Validates produced output against the tool's output schema. */
  validate(output: unknown): ToolValidationResult {
    try {
      const result = (this.schema as z.ZodType).safeParse(output);
      if (!result.success) {
        return {
          ok: false,
          issues: result.error.issues.map((i) => i.message),
          code: 'OUTPUT_VALIDATION_FAILED',
        };
      }
      return { ok: true, value: result.data };
    } catch (cause) {
      throw new ToolValidationError('Unexpected failure validating tool output', {
        code: 'OUTPUT_VALIDATION_ERROR',
        cause,
      });
    }
  }
}
