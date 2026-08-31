import { describe, expect, it } from 'vitest';

import {
  MemoryActorGroup,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import { createContextIntegrationService } from '../../../../src/agents/ag-002-memory-manager/services/context-integration.service.js';
import { createRetrievalService } from '../../../../src/agents/ag-002-memory-manager/services/retrieval.service.js';
import { createAuthorizationService } from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import { FixedClock } from '../../../../src/agents/ag-002-memory-manager/clock/index.js';
import { MemoryConfigSchema } from '../../../../src/agents/ag-002-memory-manager/config/schema.js';
import { InMemoryMemoryRepository } from '../../../../src/agents/ag-002-memory-manager/repositories/in-memory.js';
import { makeActor, makeRecord } from './fixtures.js';

/**
 * Sprint 12 — Phase 8 determinism regression.
 *
 * Deterministic-output contract: identical inputs + identical dependencies MUST
 * produce identical LOGICAL output. Dynamic correlation fields (trace ids,
 * timestamps) are explicitly exempt and must not perturb deterministic content.
 */

const config = MemoryConfigSchema.parse({
  MEMORY_CONTEXT_MAX_TOKENS: 8192,
  MEMORY_CONTEXT_MAX_SECTIONS: 8,
  MEMORY_CONTEXT_MAX_RECORDS_PER_SECTION: 20,
  MEMORY_CONTEXT_SNIPPET_LENGTH: 200,
});

describe('Sprint 12 determinism — context integration', () => {
  it('produces identical logical sections/statistics for identical input', async () => {
    const integration = createContextIntegrationService({
      authorizationService: createAuthorizationService(),
      config,
    });
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });
    const results = [
      {
        record: makeRecord({
          key: 'b',
          type: MemoryType.User,
          priority: MemoryPriority.High,
          content: 'x',
        }),
        score: 1,
      },
      {
        record: makeRecord({
          key: 'a',
          type: MemoryType.Project,
          priority: MemoryPriority.Medium,
          content: 'y',
        }),
        score: 2,
      },
    ];

    const r1 = await integration.integrate({ actor, results });
    const r2 = await integration.integrate({ actor, results });

    expect(r1.sections).toEqual(r2.sections);
    // `processingDurationMs` is an inherently dynamic wall-clock timing field
    // (explicitly exempt from the determinism contract); compare the logical
    // statistics while excluding it.
    const { processingDurationMs: _t1, ...logical1 } = r1.statistics;
    const { processingDurationMs: _t2, ...logical2 } = r2.statistics;
    expect(logical1).toEqual(logical2);
  });

  it('does not depend on input insertion order', async () => {
    const integration = createContextIntegrationService({
      authorizationService: createAuthorizationService(),
      config,
    });
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });
    const a = makeRecord({ key: 'a', priority: MemoryPriority.Low, content: 'x' });
    const b = makeRecord({ key: 'b', priority: MemoryPriority.Critical, content: 'y' });

    const r1 = await integration.integrate({
      actor,
      results: [
        { record: a, score: 1 },
        { record: b, score: 1 },
      ],
    });
    const r2 = await integration.integrate({
      actor,
      results: [
        { record: b, score: 1 },
        { record: a, score: 1 },
      ],
    });

    expect(r1.sections).toEqual(r2.sections);
  });
});

describe('Sprint 12 determinism — retrieval pipeline', () => {
  it('produces identical results for identical input', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(makeRecord({ namespace: 'user:1', key: 'k1', content: 'a' }));
    await repo.create(makeRecord({ namespace: 'user:1', key: 'k2', content: 'b' }));
    const service = createRetrievalService({
      repository: repo,
      authorizationService: createAuthorizationService(),
      clock: new FixedClock('2026-06-01T00:00:00.000Z'),
      logger: undefined,
    });
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });

    const r1 = await service.retrieve({ actor, namespace: 'user:1', query: 'x' });
    const r2 = await service.retrieve({ actor, namespace: 'user:1', query: 'x' });

    expect(r1.results.map((r) => r.record.key)).toEqual(r2.results.map((r) => r.record.key));
    expect(r1.results.map((r) => r.score)).toEqual(r2.results.map((r) => r.score));
  });
});
