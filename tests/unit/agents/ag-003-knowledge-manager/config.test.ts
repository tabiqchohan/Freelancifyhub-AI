import { describe, expect, it } from 'vitest';

import { KnowledgeConfigSchema } from '../../../../src/agents/ag-003-knowledge-manager/config/schema.js';
import { parseKnowledgeConfig } from '../../../../src/agents/ag-003-knowledge-manager/config/index.js';

describe('AG-003 config - defaults and parsing', () => {
  it('applies sensible defaults for an empty parse', () => {
    const cfg = KnowledgeConfigSchema.parse({});
    expect(cfg.KNOWLEDGE_MAX_CONTENT_BYTES).toBe(512 * 1024);
    expect(cfg.KNOWLEDGE_MAX_METADATA_KEYS).toBe(64);
    expect(cfg.KNOWLEDGE_MAX_TITLE_LENGTH).toBe(500);
    expect(cfg.KNOWLEDGE_RETRIEVAL_MAX_RESULTS).toBe(50);
    expect(cfg.KNOWLEDGE_CHUNK_MAX_SIZE).toBe(1000);
    expect(cfg.KNOWLEDGE_CHUNK_OVERLAP_SIZE).toBe(100);
    expect(cfg.KNOWLEDGE_STORAGE_BACKEND).toBe('in-memory');
    expect(cfg.KNOWLEDGE_DATABASE_URL).toBeUndefined();
    expect(cfg.KNOWLEDGE_CONTEXT_ENABLED).toBe(true);
  });

  it('overrides with provided values', () => {
    const cfg = KnowledgeConfigSchema.parse({
      KNOWLEDGE_MAX_CONTENT_BYTES: '2048',
      KNOWLEDGE_STORAGE_BACKEND: 'durable',
      KNOWLEDGE_CONTEXT_ENABLED: 'false',
    });
    expect(cfg.KNOWLEDGE_MAX_CONTENT_BYTES).toBe(2048);
    expect(cfg.KNOWLEDGE_STORAGE_BACKEND).toBe('durable');
    expect(cfg.KNOWLEDGE_CONTEXT_ENABLED).toBe(false);
  });

  it('parseKnowledgeConfig returns a typed config', () => {
    const cfg = parseKnowledgeConfig({ KNOWLEDGE_MAX_CONTENT_BYTES: '1000' });
    expect(cfg).toBeInstanceOf(Object);
    expect(cfg.KNOWLEDGE_MAX_CONTENT_BYTES).toBe(1000);
  });
});
