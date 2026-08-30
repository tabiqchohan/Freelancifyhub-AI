import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT,
  DEFAULT_MEMORY_LIFECYCLE_EVALUATION_ENABLED,
  DEFAULT_MEMORY_MAX_CONTENT_BYTES,
  DEFAULT_MEMORY_MAX_METADATA_KEYS,
  DEFAULT_MEMORY_RETRIEVAL_MAX_RESULTS,
  DEFAULT_MEMORY_RETENTION_PROJECT_ARCHIVE_MS,
  DEFAULT_MEMORY_STORAGE_BACKEND,
  DEFAULT_MEMORY_STORAGE_MAX_PAGE_SIZE,
  DEFAULT_MEMORY_TTL_CONVERSATION_MS,
  DEFAULT_MEMORY_TTL_TEMPORARY_MS,
  MemoryConfigSchema,
} from '../../../../src/agents/ag-002-memory-manager/config/schema.js';
import { MemoryConfigurationError } from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import {
  memoryConfig,
  parseMemoryConfig,
} from '../../../../src/agents/ag-002-memory-manager/config/index.js';

describe('MemoryConfigSchema - defaults (spec §17)', () => {
  it('applies architecture-default retention windows', () => {
    const config = MemoryConfigSchema.parse({});
    expect(config.MEMORY_TTL_CONVERSATION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(config.MEMORY_TTL_TEMPORARY_MS).toBe(15 * 60 * 1000);
    expect(config.MEMORY_RETENTION_PROJECT_ARCHIVE_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(config.MEMORY_MAX_CONTENT_BYTES).toBe(64 * 1024);
    expect(config.MEMORY_MAX_METADATA_KEYS).toBe(64);
    expect(config.MEMORY_RETRIEVAL_MAX_RESULTS).toBe(50);
    expect(config.MEMORY_LIFECYCLE_EVALUATION_ENABLED).toBe(true);
    expect(config.MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT).toBe(100);
  });

  it('defaults feature flags to enabled (spec §17)', () => {
    const config = MemoryConfigSchema.parse({});
    expect(config.MEMORY_RIGHT_TO_FORGET_ENABLED).toBe(true);
    expect(config.MEMORY_EVENT_LOG_REPLAY_ENABLED).toBe(true);
  });

  it('parses explicit environment values', () => {
    const config = MemoryConfigSchema.parse({
      MEMORY_TTL_CONVERSATION_MS: '60000',
      MEMORY_RETRIEVAL_MAX_RESULTS: '5',
      MEMORY_LIFECYCLE_EVALUATION_ENABLED: 'false',
      MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT: '25',
    });
    expect(config.MEMORY_TTL_CONVERSATION_MS).toBe(60000);
    expect(config.MEMORY_RETRIEVAL_MAX_RESULTS).toBe(5);
    expect(config.MEMORY_LIFECYCLE_EVALUATION_ENABLED).toBe(false);
    expect(config.MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT).toBe(25);
  });

  it('rejects invalid values rather than silently accepting them', () => {
    expect(() => MemoryConfigSchema.parse({ MEMORY_TTL_CONVERSATION_MS: '-1' })).toThrow();
    expect(() => MemoryConfigSchema.parse({ MEMORY_RETRIEVAL_MAX_RESULTS: '0' })).toThrow();
    expect(() => MemoryConfigSchema.parse({ MEMORY_RIGHT_TO_FORGET_ENABLED: 'maybe' })).toThrow();
    expect(() =>
      MemoryConfigSchema.parse({ MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT: '0' }),
    ).toThrow();
  });
});

describe('parseMemoryConfig', () => {
  it('returns a typed config and throws a typed error on invalid input', () => {
    expect(parseMemoryConfig({}).MEMORY_RETRIEVAL_MAX_RESULTS).toBe(
      DEFAULT_MEMORY_RETRIEVAL_MAX_RESULTS,
    );
    expect(() => parseMemoryConfig({ MEMORY_MAX_CONTENT_BYTES: 'nope' })).toThrow(
      MemoryConfigurationError,
    );
  });

  it('exposes a process-wide singleton', () => {
    expect(memoryConfig).toBeDefined();
    expect(memoryConfig.MEMORY_TTL_TEMPORARY_MS).toBe(DEFAULT_MEMORY_TTL_TEMPORARY_MS);
  });
});

describe('default constants mirror the architecture', () => {
  it('matches the spec §17 values', () => {
    expect(DEFAULT_MEMORY_TTL_CONVERSATION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_MEMORY_TTL_TEMPORARY_MS).toBe(15 * 60 * 1000);
    expect(DEFAULT_MEMORY_RETENTION_PROJECT_ARCHIVE_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_MEMORY_MAX_CONTENT_BYTES).toBe(64 * 1024);
    expect(DEFAULT_MEMORY_MAX_METADATA_KEYS).toBe(64);
    expect(DEFAULT_MEMORY_LIFECYCLE_EVALUATION_ENABLED).toBe(true);
    expect(DEFAULT_MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT).toBe(100);
    expect(DEFAULT_MEMORY_STORAGE_BACKEND).toBe('in-memory');
    expect(DEFAULT_MEMORY_STORAGE_MAX_PAGE_SIZE).toBe(50);
  });
});

describe('Sprint 6 - storage config fields', () => {
  it('defaults the storage backend to in-memory with a sane page size', () => {
    const config = MemoryConfigSchema.parse({});
    expect(config.MEMORY_STORAGE_BACKEND).toBe(DEFAULT_MEMORY_STORAGE_BACKEND);
    expect(config.MEMORY_STORAGE_MAX_PAGE_SIZE).toBe(DEFAULT_MEMORY_STORAGE_MAX_PAGE_SIZE);
  });

  it('parses explicit storage configuration values', () => {
    const config = MemoryConfigSchema.parse({
      MEMORY_STORAGE_BACKEND: 'in-memory',
      MEMORY_STORAGE_MAX_PAGE_SIZE: '25',
    });
    expect(config.MEMORY_STORAGE_BACKEND).toBe('in-memory');
    expect(config.MEMORY_STORAGE_MAX_PAGE_SIZE).toBe(25);
  });

  it('rejects an invalid page size', () => {
    expect(() => MemoryConfigSchema.parse({ MEMORY_STORAGE_MAX_PAGE_SIZE: '0' })).toThrow();
  });
});
