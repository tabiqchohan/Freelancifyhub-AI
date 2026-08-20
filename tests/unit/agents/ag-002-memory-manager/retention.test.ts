import { describe, expect, it } from 'vitest';

import { createTestConfig } from './fixtures.js';
import {
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import {
  defaultPriorityFor,
  defaultRetentionFor,
  defaultSecurityLevelFor,
  defaultSizeLimitFor,
  defaultTtlMsFor,
} from '../../../../src/agents/ag-002-memory-manager/classification/index.js';
import {
  computeExpiry,
  isMemoryExpired,
  isMemoryLive,
} from '../../../../src/agents/ag-002-memory-manager/retention/index.js';
import { MemoryLifecycleState } from '../../../../src/agents/ag-002-memory-manager/enums/index.js';

const config = createTestConfig();

describe('classification - per-type defaults (spec §4)', () => {
  it('maps priorities per the architecture attribute table', () => {
    expect(defaultPriorityFor(MemoryType.ShortTerm)).toBe(MemoryPriority.High);
    expect(defaultPriorityFor(MemoryType.Conversation)).toBe(MemoryPriority.High);
    expect(defaultPriorityFor(MemoryType.User)).toBe(MemoryPriority.Critical);
    expect(defaultPriorityFor(MemoryType.Project)).toBe(MemoryPriority.Critical);
    expect(defaultPriorityFor(MemoryType.Workspace)).toBe(MemoryPriority.Medium);
    expect(defaultPriorityFor(MemoryType.Organization)).toBe(MemoryPriority.Medium);
    expect(defaultPriorityFor(MemoryType.KnowledgeReference)).toBe(MemoryPriority.High);
    expect(defaultPriorityFor(MemoryType.Temporary)).toBe(MemoryPriority.Low);
    expect(defaultPriorityFor(MemoryType.Session)).toBe(MemoryPriority.Medium);
    expect(defaultPriorityFor(MemoryType.LongTerm)).toBe(MemoryPriority.High);
    expect(defaultPriorityFor(MemoryType.Archived)).toBe(MemoryPriority.Low);
  });

  it('maps security levels per the architecture attribute table', () => {
    expect(defaultSecurityLevelFor(MemoryType.ShortTerm)).toBe(MemorySecurityLevel.Internal);
    expect(defaultSecurityLevelFor(MemoryType.Workspace)).toBe(MemorySecurityLevel.Internal);
    expect(defaultSecurityLevelFor(MemoryType.KnowledgeReference)).toBe(
      MemorySecurityLevel.Internal,
    );
    expect(defaultSecurityLevelFor(MemoryType.Temporary)).toBe(MemorySecurityLevel.Internal);
    expect(defaultSecurityLevelFor(MemoryType.Conversation)).toBe(MemorySecurityLevel.Confidential);
    expect(defaultSecurityLevelFor(MemoryType.User)).toBe(MemorySecurityLevel.Confidential);
    expect(defaultSecurityLevelFor(MemoryType.Project)).toBe(MemorySecurityLevel.Confidential);
    expect(defaultSecurityLevelFor(MemoryType.Organization)).toBe(MemorySecurityLevel.Confidential);
    expect(defaultSecurityLevelFor(MemoryType.Session)).toBe(MemorySecurityLevel.Confidential);
    expect(defaultSecurityLevelFor(MemoryType.LongTerm)).toBe(MemorySecurityLevel.Confidential);
    expect(defaultSecurityLevelFor(MemoryType.Archived)).toBe(MemorySecurityLevel.Confidential);
  });

  it('maps retention policies per the architecture attribute table', () => {
    expect(defaultRetentionFor(MemoryType.ShortTerm).kind).toBe('none');
    expect(defaultRetentionFor(MemoryType.Conversation).kind).toBe('rolling_window');
    expect(defaultRetentionFor(MemoryType.User).kind).toBe('until_deletion');
    expect(defaultRetentionFor(MemoryType.Project).kind).toBe('milestone_summaries');
    expect(defaultRetentionFor(MemoryType.Workspace).kind).toBe('versioned');
    expect(defaultRetentionFor(MemoryType.Organization).kind).toBe('until_deletion');
    expect(defaultRetentionFor(MemoryType.KnowledgeReference).kind).toBe('invalidation');
    expect(defaultRetentionFor(MemoryType.Temporary).kind).toBe('none');
    expect(defaultRetentionFor(MemoryType.Session).kind).toBe('none');
    expect(defaultRetentionFor(MemoryType.LongTerm).kind).toBe('annual_consolidation');
    expect(defaultRetentionFor(MemoryType.Archived).kind).toBe('legal_hold');
  });

  it('returns the configured TTL for conversation and temporary only', () => {
    expect(defaultTtlMsFor(MemoryType.Conversation, config)).toBe(
      config.MEMORY_TTL_CONVERSATION_MS,
    );
    expect(defaultTtlMsFor(MemoryType.Temporary, config)).toBe(config.MEMORY_TTL_TEMPORARY_MS);
    expect(defaultTtlMsFor(MemoryType.User, config)).toBeUndefined();
    expect(defaultTtlMsFor(MemoryType.Session, config)).toBeUndefined();
  });

  it('reports informational size limits for the type', () => {
    expect(defaultSizeLimitFor(MemoryType.User)).toBe(512 * 1024);
    expect(defaultSizeLimitFor(MemoryType.Project)).toBe(2 * 1024 * 1024);
    expect(defaultSizeLimitFor(MemoryType.ShortTerm)).toBe(64 * 1024);
  });
});

describe('retention - TTL and expiry mechanics (spec §9)', () => {
  it('computes an expiry from a ttl', () => {
    expect(computeExpiry('2026-01-01T00:00:00.000Z', 1000)).toBe('2026-01-01T00:00:01.000Z');
  });

  it('returns undefined expiry for no ttl or zero ttl', () => {
    expect(computeExpiry('2026-01-01T00:00:00.000Z')).toBeUndefined();
    expect(computeExpiry('2026-01-01T00:00:00.000Z', 0)).toBeUndefined();
  });

  it('flags records past their expiry as expired (AC-MEM-4)', () => {
    const record = { expiresAt: '2026-01-01T00:00:00.000Z' };
    expect(isMemoryExpired(record, new Date('2026-01-02T00:00:00.000Z'))).toBe(true);
    expect(isMemoryExpired(record, new Date('2025-12-31T00:00:00.000Z'))).toBe(false);
  });

  it('never flags records without an expiry', () => {
    expect(isMemoryExpired({})).toBe(false);
  });

  it('treats deleted records as not live', () => {
    expect(isMemoryLive({ lifecycle: MemoryLifecycleState.Active })).toBe(true);
    expect(isMemoryLive({ lifecycle: MemoryLifecycleState.Deleted })).toBe(false);
  });
});
