import { describe, expect, it } from 'vitest';

import {
  KNOWLEDGE_SCHEMA_MIGRATIONS,
  KNOWLEDGE_SCHEMA_VERSION,
} from '../../../../src/agents/ag-003-knowledge-manager/storage/schema.js';

describe('AG-003 storage schema - migrations', () => {
  it('defines migrations with version numbers 100+', () => {
    expect(KNOWLEDGE_SCHEMA_MIGRATIONS.length).toBeGreaterThan(0);
    for (const m of KNOWLEDGE_SCHEMA_MIGRATIONS) {
      expect(m.version).toBeGreaterThanOrEqual(100);
      expect(m.name).toBeTruthy();
      expect(m.sql.length).toBeGreaterThan(0);
    }
  });

  it('migrations are ordered deterministically', () => {
    const versions = KNOWLEDGE_SCHEMA_MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it('versions are unique', () => {
    const versions = KNOWLEDGE_SCHEMA_MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('KNOWLEDGE_SCHEMA_VERSION equals the last migration version', () => {
    const last = KNOWLEDGE_SCHEMA_MIGRATIONS[KNOWLEDGE_SCHEMA_MIGRATIONS.length - 1];
    expect(last).toBeDefined();
    expect(KNOWLEDGE_SCHEMA_VERSION).toBe(last?.version);
  });
});
