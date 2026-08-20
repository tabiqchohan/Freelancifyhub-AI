import { MemoryValidationError } from '../errors/index.js';
import type { MemoryRecord } from '../types/index.js';
import { validateMemoryRecord } from '../validators/index.js';

/**
 * Serializes a memory record to JSON. Timestamps are stored as ISO strings so
 * round-trips are lossless and no Date marshalling is required (prompt §22).
 */
export function serializeMemoryRecord(record: MemoryRecord): string {
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
