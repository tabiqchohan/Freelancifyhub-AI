import { describe, expect, it } from 'vitest';

import { MemoryValidationError } from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import {
  parseMemoryRecord,
  serializeMemoryRecord,
} from '../../../../src/agents/ag-002-memory-manager/utils/serialization.js';
import type { MemoryRecord } from '../../../../src/agents/ag-002-memory-manager/index.js';
import { makeRecord } from './fixtures.js';

describe('serialization - safe boundaries (prompt §22)', () => {
  it('round-trips a record losslessly', () => {
    const record = makeRecord({
      content: { list: [1, 2, { ok: true }] },
      metadata: { source: 'cli' },
      expiresAt: '2026-01-02T00:00:00.000Z',
      ttlMs: 86400000,
    });
    const json = serializeMemoryRecord(record);
    expect(parseMemoryRecord(json)).toEqual(record);
  });

  it('emits valid JSON', () => {
    const json = serializeMemoryRecord(makeRecord());
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('rejects malformed JSON with a typed error', () => {
    expect(() => parseMemoryRecord('{not json')).toThrow(MemoryValidationError);
  });

  it('rejects records that fail validation after deserialization', () => {
    const record = makeRecord();
    const json = serializeMemoryRecord({
      ...record,
      type: 'NOT_A_TYPE',
    } as unknown as MemoryRecord);
    expect(() => parseMemoryRecord(json)).toThrow(MemoryValidationError);
  });

  it('does not mutate the serialized record', () => {
    const record = makeRecord();
    const snapshot = JSON.stringify(record);
    serializeMemoryRecord(record);
    expect(JSON.stringify(record)).toBe(snapshot);
  });
});
