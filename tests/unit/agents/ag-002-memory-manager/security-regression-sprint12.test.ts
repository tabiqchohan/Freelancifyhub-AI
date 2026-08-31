import { describe, expect, it } from 'vitest';

import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import {
  MemoryAccessDeniedError,
  MemoryNotFoundError,
  MemoryValidationError,
} from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import { InMemoryEventLog } from '../../../../src/agents/ag-002-memory-manager/events/index.js';
import { MemoryEventType } from '../../../../src/agents/ag-002-memory-manager/events/index.js';
import { createMemoryReplayService } from '../../../../src/agents/ag-002-memory-manager/services/index.js';
import { createRetrievalService } from '../../../../src/agents/ag-002-memory-manager/services/retrieval.service.js';
import { createContextIntegrationService } from '../../../../src/agents/ag-002-memory-manager/services/context-integration.service.js';
import { MemoryConfigSchema } from '../../../../src/agents/ag-002-memory-manager/config/schema.js';
import { createAuthorizationService } from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import { redactSecrets } from '../../../../src/agents/ag-002-memory-manager/utils/sanitize.js';
import {
  validateMemoryActor,
  validateMemorySecurityLevel,
} from '../../../../src/agents/ag-002-memory-manager/validators/index.js';
import { InMemoryMemoryRepository } from '../../../../src/agents/ag-002-memory-manager/repositories/in-memory.js';
import { createTestEnv, makeActor, makeCreateInput, makeOwner, makeRecord } from './fixtures.js';

/**
 * Sprint 12 — Phase 7 consolidated security regression suite (categories A–O).
 *
 * Each category maps to one focused regression test that exercises the REAL
 * composite authorization service (matrix + namespace scope + ownership +
 * security clearance + lifecycle) so the suite verifies actual behavior rather
 * than a stubbed authorizer. Tests are additive; existing suites are untouched.
 *
 * A.  Unauthorized read
 * B.  Unauthorized retrieval
 * C.  Unauthorized context integration
 * D.  Namespace violation
 * E.  Ownership violation
 * F.  Clearance violation
 * G.  Deleted memory
 * H.  Expired memory
 * I.  Secret leakage
 * J.  Event leakage
 * K.  Replay leakage
 * L.  Erased-memory resurrection
 * M.  Mixed authorized/unauthorized retrieval
 * N.  Fail-closed invalid actor
 * O.  Fail-closed invalid security level
 */

const realAuthorizer = createAuthorizationService();

async function retrievalService(repo: InMemoryMemoryRepository) {
  return createRetrievalService({
    repository: repo,
    authorizationService: realAuthorizer,
    clock: undefined,
    logger: undefined,
  });
}

describe('Sprint 12 security regression — A: unauthorized read', () => {
  it('getMemory denies an out-of-scope actor (scope violation)', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput({ key: 'k1' }));
    const outsider = makeActor(MemoryActorGroup.Client, ['user:99']);
    await expect(
      service.getMemory({ actor: outsider, namespace: created.namespace, key: created.key }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });
});

describe('Sprint 12 security regression — B: unauthorized retrieval', () => {
  it('retrieval never returns a record the actor lacks clearance for', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(
      makeRecord({
        namespace: 'user:1',
        key: 'top',
        securityLevel: MemorySecurityLevel.Confidential,
        content: 'must not leak',
      }),
    );
    const service = await retrievalService(repo);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Internal,
    });
    const res = await service.retrieve({ actor, namespace: 'user:1', query: 'x' });
    expect(res.results).toHaveLength(0);
  });
});

describe('Sprint 12 security regression — C: unauthorized context integration', () => {
  it('context integration excludes a Confidential record for an Internal-clearance actor', async () => {
    const integration = createContextIntegrationService({
      authorizationService: realAuthorizer,
      config: MemoryConfigSchema.parse({
        MEMORY_CONTEXT_MAX_TOKENS: 8192,
        MEMORY_CONTEXT_MAX_SECTIONS: 8,
        MEMORY_CONTEXT_MAX_RECORDS_PER_SECTION: 20,
        MEMORY_CONTEXT_SNIPPET_LENGTH: 200,
      }),
    });
    const internal = makeRecord({
      namespace: 'user:1',
      key: 'low',
      type: MemoryType.Conversation,
      securityLevel: MemorySecurityLevel.Internal,
      content: 'ok',
    });
    const confidential = makeRecord({
      namespace: 'user:1',
      key: 'high',
      type: MemoryType.Conversation,
      securityLevel: MemorySecurityLevel.Confidential,
      content: 'must not leak',
    });
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Internal,
    });
    const res = await integration.integrate({
      actor,
      results: [
        { record: internal, score: 1 },
        { record: confidential, score: 1 },
      ],
    });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('must not leak');
    // The Internal record may be authorized but the Confidential record must be
    // filtered, so at most the Internal record's section is produced.
    expect(res.statistics.authorizedCount).toBeLessThanOrEqual(1);
  });
});

describe('Sprint 12 security regression — D: namespace violation', () => {
  it('retrieval omits records outside the actor namespace allow-list', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(makeRecord({ namespace: 'user:1', key: 'own', content: 'a' }));
    await repo.create(makeRecord({ namespace: 'user:2', key: 'other', content: 'b' }));
    const service = await retrievalService(repo);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });
    const res = await service.retrieve({ actor, namespace: 'user:1', query: 'x' });
    const keys = res.results.map((r) => r.record.key);
    expect(keys).toEqual(['own']);
  });
});

describe('Sprint 12 security regression — E: ownership violation', () => {
  it('retrieval denies a project-owned record owned by another project', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(
      makeRecord({
        namespace: 'project:1',
        key: 'mine',
        type: MemoryType.Project,
        owner: makeOwner(MemoryOwnerKind.Project, '1'),
        content: 'a',
      }),
    );
    await repo.create(
      makeRecord({
        namespace: 'project:1',
        key: 'foreign',
        type: MemoryType.Project,
        owner: makeOwner(MemoryOwnerKind.Project, '99'),
        content: 'b',
      }),
    );
    const service = await retrievalService(repo);
    const actor = makeActor(MemoryActorGroup.Client, ['project:1'], { projectIds: ['1'] });
    const res = await service.retrieve({ actor, namespace: 'project:1', query: 'x' });
    const keys = res.results.map((r) => r.record.key);
    expect(keys).toEqual(['mine']);
  });
});

describe('Sprint 12 security regression — F: clearance violation', () => {
  it('retrieval omits records above the actor clearance', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(
      makeRecord({
        namespace: 'user:1',
        key: 'internal',
        securityLevel: MemorySecurityLevel.Internal,
        content: 'allowed',
      }),
    );
    await repo.create(
      makeRecord({
        namespace: 'user:1',
        key: 'confidential',
        securityLevel: MemorySecurityLevel.Confidential,
        content: 'blocked',
      }),
    );
    const service = await retrievalService(repo);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Internal,
    });
    const res = await service.retrieve({ actor, namespace: 'user:1', query: 'x' });
    const keys = res.results.map((r) => r.record.key);
    expect(keys).toEqual(['internal']);
  });
});

describe('Sprint 12 security regression — G: deleted memory', () => {
  it('deleted memory is never returned nor directly readable', async () => {
    const { service, repository } = createTestEnv();
    await repository.create(
      makeRecord({
        namespace: 'user:1',
        key: 'gone',
        lifecycle: MemoryLifecycleState.Deleted,
        content: 'ghost',
      }),
    );
    const actor = makeActor(MemoryActorGroup.Client, ['user:1']);
    const retrieved = await service.retrieveMemory({ actor, namespace: 'user:1' });
    expect(retrieved).toHaveLength(0);
    await expect(
      service.getMemory({ actor, namespace: 'user:1', key: 'gone' }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
    expect(JSON.stringify(retrieved)).not.toContain('ghost');
  });
});

describe('Sprint 12 security regression — H: expired memory', () => {
  it('expired memory is never returned', async () => {
    const { service, repository } = createTestEnv();
    await repository.create(
      makeRecord({
        namespace: 'user:1',
        key: 'expired',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:00:01.000Z',
        lifecycle: MemoryLifecycleState.Expired,
        content: 'stale',
      }),
    );
    const actor = makeActor(MemoryActorGroup.Client, ['user:1']);
    const retrieved = await service.retrieveMemory({ actor, namespace: 'user:1' });
    expect(retrieved).toHaveLength(0);
    expect(JSON.stringify(retrieved)).not.toContain('stale');
  });
});

describe('Sprint 12 security regression — I: secret leakage', () => {
  it('redactSecrets canonical redaction removes secret values at any nesting', () => {
    const out = redactSecrets({
      name: 'n',
      metadata: {
        nested: { deeper: [{ apiKey: 'sk-abc', password: 'pw_hunter' }] },
        clientSecret: 'cs_value',
        accessToken: 'at_value',
      },
    }) as {
      name: string;
      metadata: {
        nested: { deeper: { apiKey: string; password: string }[] };
        clientSecret: string;
        accessToken: string;
      };
    };
    expect(out.name).toBe('n');
    expect(out.metadata.nested.deeper[0]!.apiKey).not.toBe('sk-abc');
    expect(out.metadata.nested.deeper[0]!.password).not.toBe('pw_hunter');
    expect(out.metadata.clientSecret).not.toBe('cs_value');
    expect(out.metadata.accessToken).not.toBe('at_value');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('sk-abc');
    expect(serialized).not.toContain('pw_hunter');
    expect(serialized).not.toContain('cs_value');
    expect(serialized).not.toContain('at_value');
  });
});

describe('Sprint 12 security regression — J: event leakage', () => {
  it('the EventLog sanitizes secret-bearing metadata on append', async () => {
    const log = new InMemoryEventLog();
    log.append({
      type: MemoryEventType.Created,
      traceId: 't',
      occurredAt: '2026-06-01T00:00:00.000Z',
      namespace: 'user:1',
      key: 'k',
      metadata: { password: 'hunter2', apiKey: 'sk-live-1' },
    });
    const page = log.query({ namespace: 'user:1', maxPageSize: 100 });
    const serialized = JSON.stringify(page.items);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-live-1');
  });
});

describe('Sprint 12 security regression — K: replay leakage', () => {
  it('replay is namespace-isolated and content-free', async () => {
    const log = new InMemoryEventLog();
    log.append({
      type: MemoryEventType.Created,
      traceId: 't',
      occurredAt: '2026-06-01T00:00:00.000Z',
      namespace: 'user:1',
      key: 'k',
    });
    const replay = createMemoryReplayService({ eventLog: log });
    const outsider = makeActor(MemoryActorGroup.Client, ['user:99']);
    await expect(
      replay.replay({ namespace: 'user:1', key: 'k', actor: outsider }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    const result = await replay.replay({ namespace: 'user:1', key: 'k' });
    expect(result.state).toBe('active');
  });
});

describe('Sprint 12 security regression — L: erased-memory resurrection', () => {
  it('replay honors the tombstone and cannot resurrect erased memory', async () => {
    const log = new InMemoryEventLog();
    log.append({
      type: MemoryEventType.Created,
      traceId: 't',
      occurredAt: '2026-06-01T00:00:00.000Z',
      namespace: 'user:1',
      key: 'k',
    });
    log.append({
      type: MemoryEventType.Erased,
      traceId: 't',
      occurredAt: '2026-06-01T00:00:01.000Z',
      namespace: 'user:1',
      key: 'k',
    });
    const replay = createMemoryReplayService({ eventLog: log });
    const result = await replay.replay({ namespace: 'user:1', key: 'k' });
    expect(result.state).toBe('erased');
  });
});

describe('Sprint 12 security regression — M: mixed authorized/unauthorized', () => {
  it('returns only the authorized subset from mixed candidates', async () => {
    const repo = new InMemoryMemoryRepository();
    await repo.create(
      makeRecord({
        namespace: 'user:1',
        key: 'ok1',
        securityLevel: MemorySecurityLevel.Internal,
        content: 'a',
      }),
    );
    await repo.create(
      makeRecord({
        namespace: 'user:99',
        key: 'foreign',
        content: 'b',
      }),
    );
    await repo.create(
      makeRecord({
        namespace: 'user:1',
        key: 'ok2',
        securityLevel: MemorySecurityLevel.Internal,
        content: 'c',
      }),
    );
    const service = await retrievalService(repo);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Internal,
    });
    const res = await service.retrieve({ actor, namespace: 'user:1', query: 'x' });
    const keys = res.results.map((r) => r.record.key).sort();
    expect(keys).toEqual(['ok1', 'ok2']);
  });
});

describe('Sprint 12 security regression — N: fail-closed invalid actor', () => {
  it('a malformed actor is rejected, never treated as authorized', async () => {
    expect(() => validateMemoryActor({ group: 'HACKER', namespaces: [] })).toThrow(
      MemoryValidationError,
    );
    const { service } = createTestEnv();
    const bad = { namespaces: ['user:1'] } as never;
    await expect(
      service.getMemory({ actor: bad, namespace: 'user:1', key: 'k' }),
    ).rejects.toThrow();
  });
});

describe('Sprint 12 security regression — O: fail-closed invalid security level', () => {
  it('an unknown security level is rejected', () => {
    expect(() => validateMemorySecurityLevel('TOP_SECRET')).toThrow(MemoryValidationError);
    expect(() => validateMemorySecurityLevel('')).toThrow(MemoryValidationError);
  });
});
