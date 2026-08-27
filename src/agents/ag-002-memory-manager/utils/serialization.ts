import { MemoryValidationError } from '../errors/index.js';
import type { MemoryRecord, MemoryJsonValue } from '../types/index.js';
import { validateMemoryRecord } from '../validators/index.js';

/** Keys that are never allowed as object properties (prototype-pollution guard). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertNoPrototypePollution(value: MemoryJsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoPrototypePollution(item);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new MemoryValidationError('Memory record contains a forbidden property key', {
          code: 'PROTOTYPE_POLLUTION_GUARD',
          details: { key },
        });
      }
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        assertNoPrototypePollution(child as MemoryJsonValue);
      }
    }
  }
}

/**
 * Serializes a memory record to JSON. Timestamps are stored as ISO strings so
 * round-trips are lossless and no Date marshalling is required (prompt §22).
 * Also guards against prototype-pollution via forbidden property keys.
 */
export function serializeMemoryRecord(record: MemoryRecord): string {
  assertNoPrototypePollution(record.content);
  assertNoPrototypePollution(record.metadata);
  return JSON.stringify(record);
}

/**
 * Parses and validates a serialized memory record. Malformed JSON or records
 * that fail validation are rejected with a {@link MemoryValidationError}.
 */
export function parseMemoryRecord(json: string): MemoryRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new MemoryValidationError('Malformed memory record JSON', { cause });
  }

  return validateMemoryRecord(raw);
}
