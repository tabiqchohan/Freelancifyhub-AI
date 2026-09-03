import { describe, expect, it } from 'vitest';

import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import type { MemoryRecord } from '../../../../src/agents/ag-002-memory-manager/types/index.js';
import type { RetrievalResult } from '../../../../src/agents/ag-002-memory-manager/retrieval/index.js';
import type {
  AuthorizationService,
  MemoryActor,
} from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import { MemoryConfigSchema } from '../../../../src/agents/ag-002-memory-manager/config/schema.js';
import { makeActor, makeRecord } from './fixtures.js';
import { createContextIntegrationService } from '../../../../src/agents/ag-002-memory-manager/services/context-integration.service.js';

const allowAllAuth: AuthorizationService = {
  name: 'test-allow-all',
  authorize: () => ({ allowed: true }),
};

const denyAuth: AuthorizationService = {
  name: 'test-deny-all',
  authorize: () => ({ allowed: false, reason: 'denied for test', code: 'DENIED' }),
};

function toResults(
  records: MemoryRecord[],
  scores: Record<string, number> = {},
): RetrievalResult[] {
  return records.map((record) => ({ record, score: scores[record.key] ?? 0.5 }));
}

function makeService(
  options: {
    allow?: boolean;
    budget?: number;
    maxSections?: number;
    recordsPerSection?: number;
    snippetLength?: number;
  } = {},
) {
  const config = MemoryConfigSchema.parse({
    MEMORY_CONTEXT_MAX_TOKENS: options.budget ?? 8192,
    MEMORY_CONTEXT_MAX_SECTIONS: options.maxSections ?? 8,
    MEMORY_CONTEXT_MAX_RECORDS_PER_SECTION: options.recordsPerSection ?? 20,
    MEMORY_CONTEXT_SNIPPET_LENGTH: options.snippetLength ?? 200,
  });
  return createContextIntegrationService({
    authorizationService: options.allow === false ? denyAuth : allowAllAuth,
    config,
  });
}

const actor: MemoryActor = makeActor(MemoryActorGroup.MemoryManager, ['user:1', 'project:1']);

describe('ContextIntegrationService (Sprint 5A)', () => {
  describe('A. basic context assembly', () => {
    it('assembles sections from retrieval results', async () => {
      const service = makeService();
      const rec = makeRecord({ key: 'pref', type: MemoryType.User, content: 'theme dark' });
      const res = await service.integrate({ actor, results: toResults([rec]) });
      expect(res.enabled).toBe(true);
      expect(res.sections.length).toBe(1);
      expect(res.sections[0]!.type).toBe(MemoryType.User);
      expect(res.sections[0]!.records.length).toBe(1);
      expect(res.sections[0]!.records[0]!.key).toBe('pref');
    });
  });

  describe('B. empty input', () => {
    it('returns empty sections with zero statistics for empty results', async () => {
      const service = makeService();
      const res = await service.integrate({ actor, results: [] });
      expect(res.sections).toEqual([]);
      expect(res.statistics.inputCount).toBe(0);
      expect(res.statistics.sectionsGenerated).toBe(0);
      expect(res.statistics.selectedCount).toBe(0);
    });
  });

  describe('C. single result', () => {
    it('handles a single retrieval result', async () => {
      const service = makeService();
      const rec = makeRecord({ key: 'only', type: MemoryType.Project, content: 'x' });
      const res = await service.integrate({ actor, results: toResults([rec]) });
      expect(res.sections.length).toBe(1);
      expect(res.sections[0]!.records.length).toBe(1);
      expect(res.statistics.selectedCount).toBe(1);
    });
  });

  describe('D. multiple sections', () => {
    it('groups records of different types into separate sections', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({ key: 'u', type: MemoryType.User, content: 'a' }),
        makeRecord({ key: 'p', type: MemoryType.Project, content: 'b' }),
        makeRecord({ key: 'w', type: MemoryType.Workspace, content: 'c' }),
      ]);
      const res = await service.integrate({ actor, results });
      expect(res.sections.length).toBe(3);
      expect(res.sections.map((s) => s.type).sort()).toEqual(
        [MemoryType.Workspace, MemoryType.User, MemoryType.Project].sort(),
      );
    });
  });

  describe('E. section ordering', () => {
    it('orders sections deterministically by section priority', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({ key: 't', type: MemoryType.Temporary, content: 'a' }),
        makeRecord({ key: 'u', type: MemoryType.User, content: 'b' }),
      ]);
      const res = await service.integrate({ actor, results });
      // USER section priority (8) > TEMPORARY (1)
      expect(res.sections[0]!.type).toBe(MemoryType.User);
      expect(res.sections[1]!.type).toBe(MemoryType.Temporary);
    });
  });

  describe('F. priority ordering', () => {
    it('orders records within a section by memory priority', async () => {
      const service = makeService();
      const results = toResults(
        [
          makeRecord({
            key: 'low',
            type: MemoryType.User,
            priority: MemoryPriority.Low,
            content: 'a',
          }),
          makeRecord({
            key: 'crit',
            type: MemoryType.User,
            priority: MemoryPriority.Critical,
            content: 'b',
          }),
          makeRecord({
            key: 'med',
            type: MemoryType.User,
            priority: MemoryPriority.Medium,
            content: 'c',
          }),
        ],
        { low: 0.9, crit: 0.1, med: 0.5 },
      );
      const res = await service.integrate({ actor, results });
      const keys = res.sections[0]!.records.map((r) => r.key);
      expect(keys[0]).toBe('crit');
      expect(keys[keys.length - 1]).toBe('low');
    });
  });

  describe('G. CRITICAL preservation', () => {
    it('preserves CRITICAL records under budget pressure', async () => {
      const service = makeService({ budget: 100 });
      const big = 'x'.repeat(500);
      const results = toResults([
        makeRecord({
          key: 'crit',
          type: MemoryType.User,
          priority: MemoryPriority.Critical,
          content: 'short critical',
        }),
        makeRecord({
          key: 'med',
          type: MemoryType.User,
          priority: MemoryPriority.Medium,
          content: big,
        }),
      ]);
      const res = await service.integrate({ actor, results });
      const keys = res.sections[0]!.records.map((r) => r.key);
      expect(keys).toContain('crit');
    });
  });

  describe('H. HIGH preservation', () => {
    it('preserves HIGH records ahead of LOW records', async () => {
      const service = makeService({ budget: 100 });
      const big = 'y'.repeat(500);
      const results = toResults([
        makeRecord({
          key: 'high',
          type: MemoryType.User,
          priority: MemoryPriority.High,
          content: 'short high',
        }),
        makeRecord({
          key: 'low',
          type: MemoryType.User,
          priority: MemoryPriority.Low,
          content: big,
        }),
      ]);
      const res = await service.integrate({ actor, results });
      const keys = res.sections[0]!.records.map((r) => r.key);
      expect(keys[0]).toBe('high');
    });
  });

  describe('I. MEDIUM/LOW budget eviction', () => {
    it('evicts lower-priority records first when budget is tight', async () => {
      const service = makeService({ budget: 100 });
      const big = 'z'.repeat(500);
      const results = toResults([
        makeRecord({
          key: 'med',
          type: MemoryType.User,
          priority: MemoryPriority.Medium,
          content: 'short medium',
        }),
        makeRecord({
          key: 'low',
          type: MemoryType.User,
          priority: MemoryPriority.Low,
          content: big,
        }),
      ]);
      const res = await service.integrate({ actor, results });
      const keys = res.sections[0]!.records.map((r) => r.key);
      // MEDIUM should be kept, LOW evicted
      expect(keys).toContain('med');
      expect(keys).not.toContain('low');
    });
  });

  describe('J. tiny budget', () => {
    it('truncates and reports truncation statistics', async () => {
      const service = makeService({ budget: 10 });
      const results = toResults([
        makeRecord({
          key: 'a',
          type: MemoryType.User,
          priority: MemoryPriority.Critical,
          content: 'x'.repeat(200),
        }),
        makeRecord({
          key: 'b',
          type: MemoryType.User,
          priority: MemoryPriority.High,
          content: 'x'.repeat(200),
        }),
      ]);
      const res = await service.integrate({ actor, results });
      expect(res.metadata.truncated).toBe(true);
      expect(res.statistics.truncatedCount).toBeGreaterThan(0);
    });

    it('zero budget yields empty sections', async () => {
      const service = makeService({ budget: 0 });
      const results = toResults([
        makeRecord({ key: 'a', type: MemoryType.User, content: 'hello' }),
      ]);
      const res = await service.integrate({ actor, results });
      expect(res.sections[0]!.records.length).toBe(0);
    });
  });

  describe('K. large budget', () => {
    it('includes all records when budget is large', async () => {
      const service = makeService({ budget: 100000 });
      const results = toResults(
        Array.from({ length: 10 }, (_, i) =>
          makeRecord({
            key: `k${i}`,
            type: MemoryType.User,
            priority: MemoryPriority.Medium,
            content: 'data',
          }),
        ),
      );
      const res = await service.integrate({ actor, results });
      expect(res.sections[0]!.records.length).toBe(10);
    });
  });

  describe('L. deterministic output', () => {
    it('produces identical output for identical input', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          key: 'b',
          type: MemoryType.User,
          priority: MemoryPriority.High,
          content: 'x',
        }),
        makeRecord({
          key: 'a',
          type: MemoryType.Project,
          priority: MemoryPriority.Medium,
          content: 'y',
        }),
      ]);
      const r1 = await service.integrate({ actor, results });
      const r2 = await service.integrate({ actor, results });
      expect(r1.sections).toEqual(r2.sections);
      // All statistics fields are deterministic except the wall-clock
      // processingDurationMs counter, which varies between runs.
      const s1 = { ...r1.statistics, processingDurationMs: 0 };
      const s2 = { ...r2.statistics, processingDurationMs: 0 };
      expect(s1).toEqual(s2);
    });

    it('does not depend on input insertion order', async () => {
      const service = makeService();
      const recA = makeRecord({
        key: 'a',
        namespace: 'user:1',
        type: MemoryType.User,
        priority: MemoryPriority.Low,
        content: 'x',
      });
      const recB = makeRecord({
        key: 'b',
        namespace: 'user:1',
        type: MemoryType.User,
        priority: MemoryPriority.Critical,
        content: 'y',
      });
      const r1 = await service.integrate({ actor, results: toResults([recA, recB]) });
      const r2 = await service.integrate({ actor, results: toResults([recB, recA]) });
      expect(r1.sections).toEqual(r2.sections);
    });
  });

  describe('M. deduplication', () => {
    it('deduplicates records with the same namespace:key', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          id: '1',
          key: 'same',
          namespace: 'user:1',
          type: MemoryType.User,
          priority: MemoryPriority.High,
          version: 1,
          content: 'v1',
        }),
        makeRecord({
          id: '2',
          key: 'same',
          namespace: 'user:1',
          type: MemoryType.User,
          priority: MemoryPriority.High,
          version: 2,
          content: 'v2',
        }),
      ]);
      const res = await service.integrate({ actor, results });
      expect(res.statistics.duplicateCount).toBe(1);
      expect(res.sections[0]!.records.length).toBe(1);
      expect(res.sections[0]!.records[0]!.version).toBe(2);
    });
  });

  describe('N. duplicate priority handling', () => {
    it('retains the highest-priority representation of a duplicate', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          id: '1',
          key: 'dup',
          namespace: 'user:1',
          type: MemoryType.User,
          priority: MemoryPriority.Critical,
          version: 1,
          content: 'crit',
        }),
        makeRecord({
          id: '2',
          key: 'dup',
          namespace: 'user:1',
          type: MemoryType.User,
          priority: MemoryPriority.Low,
          version: 9,
          content: 'low',
        }),
      ]);
      const res = await service.integrate({ actor, results });
      expect(res.sections[0]!.records.length).toBe(1);
      expect(res.sections[0]!.records[0]!.priority).toBe(MemoryPriority.Critical);
    });
  });

  describe('O. relevance ordering', () => {
    it('orders records of equal priority by relevance score', async () => {
      const service = makeService();
      const results = toResults(
        [
          makeRecord({
            key: 'lower',
            type: MemoryType.User,
            priority: MemoryPriority.Medium,
            content: 'a',
          }),
          makeRecord({
            key: 'higher',
            type: MemoryType.User,
            priority: MemoryPriority.Medium,
            content: 'b',
          }),
        ],
        { lower: 0.3, higher: 0.9 },
      );
      const res = await service.integrate({ actor, results });
      expect(res.sections[0]!.records[0]!.key).toBe('higher');
    });
  });

  describe('P. sanitization', () => {
    it('redacts apiKey, password, and token from content snippets', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          key: 's',
          type: MemoryType.User,
          content: 'apiKey: sk-live-1234567890abcdef, password: supersecret, token: abc123',
        }),
      ]);
      const res = await service.integrate({ actor, results });
      const snippet = res.sections[0]!.records[0]!.snippet;
      expect(snippet).not.toContain('sk-live');
      expect(snippet).not.toContain('supersecret');
      expect(snippet).not.toContain('abc123');
      expect(res.sanitized).toBe(true);
    });
  });

  describe('Q. nested secret sanitization', () => {
    it('redacts secrets in nested metadata objects', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          key: 'nested',
          type: MemoryType.User,
          content: { config: { credentials: { password: 'nested-secret-value' } } },
        }),
      ]);
      const res = await service.integrate({ actor, results });
      const snippet = res.sections[0]!.records[0]!.snippet;
      expect(snippet).not.toContain('nested-secret-value');
    });
  });

  describe('R. case-insensitive secret sanitization', () => {
    it('redacts secrets regardless of key casing', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          key: 'case',
          type: MemoryType.User,
          content: 'ApiKey: sk-CASE, PASSWORD: caseSecret, TOKEN: tok123, pWd: pwd123',
        }),
      ]);
      const res = await service.integrate({ actor, results });
      const snippet = res.sections[0]!.records[0]!.snippet;
      expect(snippet).not.toContain('sk-CASE');
      expect(snippet).not.toContain('caseSecret');
      expect(snippet).not.toContain('tok123');
      expect(snippet).not.toContain('pwd123');
    });
  });

  describe('S. immutability', () => {
    it('does not mutate input results or records', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({ key: 'a', type: MemoryType.User, content: 'hello', metadata: { note: 'x' } }),
        makeRecord({ key: 'b', type: MemoryType.Project, content: 'world' }),
      ]);
      const before = JSON.parse(JSON.stringify(results));
      await service.integrate({ actor, results });
      expect(JSON.parse(JSON.stringify(results))).toEqual(before);
    });
  });

  describe('T. invalid request', () => {
    it('throws a typed validation error for a missing actor', async () => {
      const service = makeService();
      await expect(
        service.integrate({ actor: undefined as unknown as MemoryActor, results: [] }),
      ).rejects.toThrow(/actor/i);
    });

    it('throws for a non-array results value', async () => {
      const service = makeService();
      await expect(
        service.integrate({ actor, results: undefined as unknown as RetrievalResult[] }),
      ).rejects.toThrow();
    });
  });

  describe('U. invalid budget', () => {
    it('throws a typed validation error for a negative budget', async () => {
      const service = makeService();
      await expect(
        service.integrate({ actor, results: [], contextBudgetTokens: -5 }),
      ).rejects.toThrow(/budget/i);
    });
  });

  describe('authorization exclusion', () => {
    it('excludes records that fail authorization at the trust boundary', async () => {
      const service = makeService({ allow: false });
      const results = toResults([makeRecord({ key: 'x', type: MemoryType.User, content: 'a' })]);
      const res = await service.integrate({ actor, results });
      expect(res.statistics.authorizedCount).toBe(0);
      expect(res.sections.length).toBe(0);
    });

    it('excludes DELETED and EXPIRED records', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          key: 'del',
          type: MemoryType.User,
          lifecycle: MemoryLifecycleState.Deleted,
          content: 'a',
        }),
        makeRecord({
          key: 'exp',
          type: MemoryType.User,
          lifecycle: MemoryLifecycleState.Expired,
          content: 'b',
        }),
        makeRecord({
          key: 'ok',
          type: MemoryType.User,
          lifecycle: MemoryLifecycleState.Active,
          content: 'c',
        }),
      ]);
      const res = await service.integrate({ actor, results });
      const keys = res.sections.length ? res.sections[0]!.records.map((r) => r.key) : [];
      expect(keys).toContain('ok');
      expect(keys).not.toContain('del');
      expect(keys).not.toContain('exp');
    });
  });

  describe('V. large result set', () => {
    it('handles hundreds of results deterministically', async () => {
      const service = makeService({ budget: 1000000, recordsPerSection: 1000 });
      const results = toResults(
        Array.from({ length: 500 }, (_, i) =>
          makeRecord({
            key: `k${i}`,
            namespace: `user:${i % 3}`,
            type: MemoryType.User,
            priority: MemoryPriority.Medium,
            content: `content ${i}`,
          }),
        ),
      );
      const res = await service.integrate({ actor, results });
      expect(res.sections[0]!.records.length).toBe(500);
      expect(res.statistics.inputCount).toBe(500);
    });
  });

  describe('W. large metadata', () => {
    it('handles records with large metadata without leaking', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          key: 'lg',
          type: MemoryType.User,
          content: 'small',
          metadata: { data: ' '.repeat(500) },
        }),
      ]);
      const res = await service.integrate({ actor, results });
      expect(res.sections[0]!.records[0]!.snippet.length).toBeLessThanOrEqual(203);
    });
  });

  describe('X. deep nested metadata', () => {
    it('redacts secrets in deeply nested metadata', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          key: 'deep',
          type: MemoryType.User,
          content: 'ok',
          metadata: {
            level1: { level2: { level3: { credential: 'deep-secret-xyz' } } },
          },
        }),
      ]);
      const res = await service.integrate({ actor, results });
      const snippet = res.sections[0]!.records[0]!.snippet;
      expect(snippet).not.toContain('deep-secret-xyz');
    });
  });

  describe('Y. statistics correctness', () => {
    it('reports accurate statistics', async () => {
      const service = makeService({ budget: 2000 });
      const big = 'q'.repeat(400);
      const results = toResults([
        makeRecord({
          key: 'a',
          type: MemoryType.User,
          priority: MemoryPriority.Critical,
          content: big,
        }),
        makeRecord({
          key: 'b',
          type: MemoryType.User,
          priority: MemoryPriority.Medium,
          content: big,
        }),
      ]);
      const res = await service.integrate({ actor, results });
      expect(res.statistics.inputCount).toBe(2);
      expect(res.statistics.authorizedCount).toBe(2);
      expect(res.statistics.sectionsGenerated).toBe(1);
      expect(res.statistics.budget).toBe(2000);
      expect(res.statistics.selectedCount + res.statistics.truncatedCount).toBe(2);
    });
  });

  describe('Z. feature disabled behavior', () => {
    it('returns disabled response with empty sections when feature is off', async () => {
      const config = MemoryConfigSchema.parse({ MEMORY_CONTEXT_INTEGRATION_ENABLED: 'false' });
      const service = createContextIntegrationService({
        authorizationService: allowAllAuth,
        config,
      });
      const results = toResults([makeRecord({ key: 'a', type: MemoryType.User, content: 'x' })]);
      const res = await service.integrate({ actor, results });
      expect(res.enabled).toBe(false);
      expect(res.sections).toEqual([]);
    });
  });

  describe('security guarantees (prompt §13)', () => {
    const SECRET_KEYS = [
      'apiKey',
      'password',
      'token',
      'secret',
      'credential',
      'pwd',
      'passphrase',
    ];

    it.each(SECRET_KEYS)('never leaks %s in record content', async (secretName) => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          key: 's',
          type: MemoryType.User,
          content: `${secretName}: leaked-value-${secretName}`,
        }),
      ]);
      const res = await service.integrate({ actor, results });
      const json = JSON.stringify(res.sections);
      expect(json).not.toMatch(new RegExp(`leaked-value-${secretName}|${secretName}\\s*[:=]`, 'i'));
    });

    it.each(SECRET_KEYS)('never leaks %s in metadata', async (secretName) => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          key: 's',
          type: MemoryType.User,
          content: 'ok',
          metadata: { [secretName]: `meta-leak-${secretName}` },
        }),
      ]);
      const res = await service.integrate({ actor, results });
      const json = JSON.stringify(res.sections);
      expect(json).not.toContain(`meta-leak-${secretName}`);
    });

    it('does not expose secrets across multiple records', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({ key: 'a', type: MemoryType.User, content: 'password: secretA' }),
        makeRecord({ key: 'b', type: MemoryType.Project, content: 'apiKey: sk-secretB' }),
      ]);
      const res = await service.integrate({ actor, results });
      const json = JSON.stringify(res.sections);
      expect(json).not.toContain('secretA');
      expect(json).not.toContain('sk-secretB');
    });
  });

  describe('section request filtering', () => {
    it('only generates requested sections', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({ key: 'u', type: MemoryType.User, content: 'a' }),
        makeRecord({ key: 'p', type: MemoryType.Project, content: 'b' }),
      ]);
      const res = await service.integrate({
        actor,
        results,
        sections: [{ type: MemoryType.Project }],
      });
      expect(res.sections.length).toBe(1);
      expect(res.sections[0]!.type).toBe(MemoryType.Project);
    });
  });

  describe('snippet bounding', () => {
    it('bounds snippet to configured length', async () => {
      const service = makeService({ snippetLength: 20 });
      const results = toResults([
        makeRecord({ key: 'a', type: MemoryType.User, content: 'a'.repeat(500) }),
      ]);
      const res = await service.integrate({ actor, results });
      expect(res.sections[0]!.records[0]!.snippet.length).toBeLessThanOrEqual(20);
    });
  });

  describe('security level projection', () => {
    it('exposes the security level without leaking content in metadata', async () => {
      const service = makeService();
      const results = toResults([
        makeRecord({
          key: 'a',
          type: MemoryType.User,
          securityLevel: MemorySecurityLevel.Confidential,
          content: 'x',
        }),
      ]);
      const res = await service.integrate({ actor, results });
      expect(res.sections[0]!.records[0]!.securityLevel).toBe(MemorySecurityLevel.Confidential);
    });
  });
});
