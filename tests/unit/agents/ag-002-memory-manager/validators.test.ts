import { describe, expect, it } from 'vitest';

import {
  MemoryOwnerKind,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import type { MemoryLifecycleState } from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import { MemoryValidationError } from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import {
  validateMemoryActor,
  validateMemoryContent,
  validateMemoryId,
  validateMemoryKey,
  validateMemoryMetadata,
  validateMemoryNamespace,
  validateMemoryOwner,
  validateMemoryPriority,
  validateMemoryRecord,
  validateMemoryRecordFilter,
  validateMemorySecurityLevel,
  validateMemoryType,
  validateMemoryVersion,
  validateReason,
  validateTraceId,
  validateTtl,
  validateTtlMs,
} from '../../../../src/agents/ag-002-memory-manager/validators/index.js';
import { makeRecord } from './fixtures.js';

describe('validateMemoryId (B)', () => {
  it('accepts ids in the memory_ form', () => {
    expect(validateMemoryId('memory_123')).toBe('memory_123');
    expect(validateMemoryId('memory_abc-ABC_1')).toBe('memory_abc-ABC_1');
  });

  it('rejects non-conforming ids', () => {
    expect(() => validateMemoryId('123')).toThrow(MemoryValidationError);
    expect(() => validateMemoryId('')).toThrow(MemoryValidationError);
    expect(() => validateMemoryId(undefined)).toThrow(MemoryValidationError);
  });
});

describe('validateMemoryNamespace (B)', () => {
  it('accepts scope:value namespaces from the spec', () => {
    for (const namespace of [
      'system:plans',
      'client:42',
      'freelancer:7',
      'project:9',
      'org:1',
      'workspace:admin:1',
    ]) {
      expect(validateMemoryNamespace(namespace)).toBe(namespace);
    }
  });

  it('rejects empty or malformed namespaces', () => {
    expect(() => validateMemoryNamespace('')).toThrow(MemoryValidationError);
    expect(() => validateMemoryNamespace(':nope')).toThrow(MemoryValidationError);
    expect(() => validateMemoryNamespace('user')).not.toThrow(); // single segment is accepted
  });
});

describe('validateMemoryKey (B)', () => {
  it('accepts non-empty keys', () => {
    expect(validateMemoryKey('pref_theme')).toBe('pref_theme');
  });
  it('rejects empty keys', () => {
    expect(() => validateMemoryKey('')).toThrow(MemoryValidationError);
  });
});

describe('validateMemoryOwner (F)', () => {
  it('accepts every ownership kind with a typed id', () => {
    for (const kind of Object.values(MemoryOwnerKind)) {
      expect(validateMemoryOwner({ kind, id: '42' })).toEqual({ kind, id: '42' });
    }
  });

  it('rejects an unknown kind or empty id', () => {
    expect(() => validateMemoryOwner({ kind: 'owner', id: '42' })).toThrow(MemoryValidationError);
    expect(() => validateMemoryOwner({ kind: MemoryOwnerKind.User, id: '' })).toThrow(
      MemoryValidationError,
    );
  });
});

describe('validateMemoryActor (G)', () => {
  it('accepts a valid actor with an allow-list', () => {
    expect(validateMemoryActor({ group: 'CLIENT', namespaces: ['user:1'] })).toEqual({
      group: 'CLIENT',
      namespaces: ['user:1'],
    });
  });

  it('rejects an unknown actor group', () => {
    expect(() => validateMemoryActor({ group: 'HACKER', namespaces: [] })).toThrow(
      MemoryValidationError,
    );
  });
});

describe('validateMemoryContent (C)', () => {
  it('accepts primitives', () => {
    expect(validateMemoryContent('plain')).toBe('plain');
    expect(validateMemoryContent(42)).toBe(42);
    expect(validateMemoryContent(true)).toBe(true);
    expect(validateMemoryContent(null)).toBe(null);
  });

  it('accepts structured, JSON-compatible content', () => {
    const content = {
      theme: 'dark',
      tags: ['ai', 'freelance'],
      counters: { views: 3, nested: [1, 2, { ok: true }] },
    };
    expect(validateMemoryContent(content)).toEqual(content);
  });

  it('rejects non-JSON values (functions, undefined, symbols)', () => {
    expect(() => validateMemoryContent(() => 'x')).toThrow(MemoryValidationError);
    expect(() => validateMemoryContent(undefined)).toThrow(MemoryValidationError);
    expect(() => validateMemoryContent(Symbol('x'))).toThrow(MemoryValidationError);
    expect(() => validateMemoryContent({ fn: () => 'x' })).toThrow(MemoryValidationError);
  });

  it('rejects NaN and Infinity numbers', () => {
    expect(() => validateMemoryContent(NaN)).toThrow(MemoryValidationError);
    expect(() => validateMemoryContent(Number.POSITIVE_INFINITY)).toThrow(MemoryValidationError);
  });
});

describe('validateMemoryMetadata (B)', () => {
  it('accepts a JSON record', () => {
    expect(validateMemoryMetadata({ source: 'cli', flags: [1, 2] })).toEqual({
      source: 'cli',
      flags: [1, 2],
    });
  });

  it('rejects non-object metadata', () => {
    expect(() => validateMemoryMetadata('nope')).toThrow(MemoryValidationError);
    expect(() => validateMemoryMetadata(null)).toThrow(MemoryValidationError);
  });
});

describe('validateMemoryType (D)', () => {
  it('accepts the eleven canonical types only', () => {
    for (const type of Object.values(MemoryType)) {
      expect(validateMemoryType(type)).toBe(type);
    }
  });

  it('rejects unknown types', () => {
    expect(() => validateMemoryType('EMOTION')).toThrow(MemoryValidationError);
    expect(() => validateMemoryType('')).toThrow(MemoryValidationError);
  });
});

describe('validateMemoryPriority (K)', () => {
  it('accepts the four priorities', () => {
    for (const priority of Object.values(MemoryPriority)) {
      expect(validateMemoryPriority(priority)).toBe(priority);
    }
  });

  it('rejects unknown priorities', () => {
    expect(() => validateMemoryPriority('URGENT')).toThrow(MemoryValidationError);
  });
});

describe('validateMemorySecurityLevel (H)', () => {
  it('accepts internal and confidential only', () => {
    expect(validateMemorySecurityLevel(MemorySecurityLevel.Internal)).toBe('INTERNAL');
    expect(validateMemorySecurityLevel(MemorySecurityLevel.Confidential)).toBe('CONFIDENTIAL');
  });

  it('rejects invented levels', () => {
    expect(() => validateMemorySecurityLevel('TOP_SECRET')).toThrow(MemoryValidationError);
  });
});

describe('validateMemoryVersion (S)', () => {
  it('accepts positive integers', () => {
    expect(validateMemoryVersion(1)).toBe(1);
    expect(validateMemoryVersion(99)).toBe(99);
  });

  it('rejects zero, negatives and non-integers', () => {
    expect(() => validateMemoryVersion(0)).toThrow(MemoryValidationError);
    expect(() => validateMemoryVersion(-1)).toThrow(MemoryValidationError);
    expect(() => validateMemoryVersion(1.5)).toThrow(MemoryValidationError);
  });
});

describe('validateTtl (I)', () => {
  it('accepts a ttl without expiry and an expiry without ttl', () => {
    expect(validateTtl({ createdAt: '2026-01-01T00:00:00.000Z', ttlMs: 1000 })).toEqual({
      ttlMs: 1000,
    });
    expect(
      validateTtl({ createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' }),
    ).toEqual({ expiresAt: '2026-01-02T00:00:00.000Z' });
  });

  it('accepts a consistent ttl + expiry pair', () => {
    const result = validateTtl({
      createdAt: '2026-01-01T00:00:00.000Z',
      ttlMs: 86400000,
      expiresAt: '2026-01-02T00:00:00.000Z',
    });
    expect(result).toEqual({ ttlMs: 86400000, expiresAt: '2026-01-02T00:00:00.000Z' });
  });

  it('rejects an inconsistent ttl + expiry pair', () => {
    expect(() =>
      validateTtl({
        createdAt: '2026-01-01T00:00:00.000Z',
        ttlMs: 1000,
        expiresAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toThrow(MemoryValidationError);
  });

  it('rejects negative or fractional ttl', () => {
    expect(() => validateTtlMs(-1)).toThrow(MemoryValidationError);
    expect(() => validateTtlMs(1.5)).toThrow(MemoryValidationError);
  });

  it('accepts ttl 0 as "no expiry"', () => {
    expect(validateTtlMs(0)).toBe(0);
  });
});

describe('validateMemoryRecord (B)', () => {
  it('accepts a fully valid record unchanged', () => {
    const record = makeRecord();
    expect(validateMemoryRecord(record)).toEqual(record);
  });

  it('rejects a malformed record (missing reason)', () => {
    const record = makeRecord();
    const { reason: _reason, ...withoutReason } = record;
    expect(() => validateMemoryRecord(withoutReason)).toThrow(MemoryValidationError);
  });

  it('rejects a record with a bad lifecycle state', () => {
    const record = makeRecord({ lifecycle: 'SUMMARIZED' as unknown as MemoryLifecycleState });
    expect(() => validateMemoryRecord(record)).toThrow(MemoryValidationError);
  });

  it('rejects a record exceeding the content size limit', () => {
    const record = makeRecord({ content: 'x'.repeat(64 * 1024 + 1) });
    expect(() =>
      validateMemoryRecord(record, { maxContentBytes: 64 * 1024, maxMetadataKeys: 64 }),
    ).toThrow(MemoryValidationError);
  });

  it('rejects a record exceeding the metadata key limit', () => {
    const metadata: Record<string, string> = {};
    for (let i = 0; i < 65; i += 1) {
      metadata[`k${i}`] = 'v';
    }
    const record = makeRecord({ metadata });
    expect(() =>
      validateMemoryRecord(record, { maxContentBytes: 65536, maxMetadataKeys: 64 }),
    ).toThrow(MemoryValidationError);
  });

  it('enforces the configured limits', () => {
    const record = makeRecord({ content: 'y'.repeat(1024) });
    expect(() =>
      validateMemoryRecord(record, { maxContentBytes: 128, maxMetadataKeys: 64 }),
    ).toThrow(MemoryValidationError);
  });

  it('does not mutate the input record', () => {
    const record = makeRecord();
    const snapshot = JSON.stringify(record);
    validateMemoryRecord(record);
    expect(JSON.stringify(record)).toBe(snapshot);
  });
});

describe('validateMemoryRecordFilter (L)', () => {
  it('accepts partial filters', () => {
    expect(
      validateMemoryRecordFilter({ type: MemoryType.User, priority: MemoryPriority.High }),
    ).toEqual({
      type: MemoryType.User,
      priority: MemoryPriority.High,
    });
  });

  it('rejects invalid filter values', () => {
    expect(() => validateMemoryRecordFilter({ type: 'NOPE' })).toThrow(MemoryValidationError);
  });
});

describe('validateReason / validateTraceId (M)', () => {
  it('rejects empty reasons and trace ids', () => {
    expect(() => validateReason('')).toThrow(MemoryValidationError);
    expect(() => validateTraceId('')).toThrow(MemoryValidationError);
    expect(validateReason('consent update')).toBe('consent update');
  });
});
