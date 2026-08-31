import { describe, expect, it } from 'vitest';

import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import type { AuthorizationService } from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import { createAuthorizationService } from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import { createRetrievalService } from '../../../../src/agents/ag-002-memory-manager/services/retrieval.service.js';
import { InMemoryMemoryRepository } from '../../../../src/agents/ag-002-memory-manager/repositories/in-memory.js';
import { createTestEnv, makeActor, makeOwner, makeRecord } from './fixtures.js';

/**
 * Sprint 12 regression suite for CRIT-1.
 *
 * The original retrieval bug computed `scopeFiltered`/`securityFiltered` but
 * discarded them and scored on the authorized-only collection, so a permissive
 * (or incorrectly-configured) authorization service allowed out-of-scope or
 * insufficient-clearance records to leak into RetrievalResponse.
 *
 * These tests reproduce that exact path using a permissive authorization layer
 * and assert that retrieval's own scope/security filters (the defense-in-depth
 * gates) are actually propagated into the response. Every test here fails
 * against the old implementation and passes against the fixed one.
 */

const allowAllAuthorizer: AuthorizationService = {
  name: 'test-allow-all',
  authorize: () => ({ allowed: true }),
};

/** Real composite policy authorizer used where ownership is the gate under test. */
const realAuthorizer = createAuthorizationService();

async function buildService(authorizer: AuthorizationService = allowAllAuthorizer) {
  const repo = new InMemoryMemoryRepository();
  const service = createRetrievalService({
    repository: repo,
    authorizationService: authorizer,
    clock: undefined,
    logger: undefined,
  });
  return { repo, service };
}

function seed(
  repo: InMemoryMemoryRepository,
  records: Parameters<InMemoryMemoryRepository['create']>[0][],
) {
  return Promise.all(records.map((r) => repo.create(r)));
}

describe('CRIT-1 regression - scope/security filters are propagated', () => {
  it('1. excludes records from an unauthorized namespace (permissive authorizer)', async () => {
    const { repo, service } = await buildService(allowAllAuthorizer);
    await seed(repo, [
      makeRecord({ namespace: 'user:1', key: 'own', content: 'allowed' }),
      makeRecord({ namespace: 'user:99', key: 'foreign', content: 'must not leak' }),
    ]);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });

    const results = await service.retrieve({ actor, namespace: 'user:1', query: 'test' });

    const keys = results.results.map((r) => r.record.key);
    expect(keys).toContain('own');
    expect(keys).not.toContain('foreign');
  });

  it('2. excludes records the actor does not own (ownership gate via real authorizer)', async () => {
    const { repo, service } = await buildService(realAuthorizer);
    // A PROJECT-owned memory in the actor's namespace but outside the actor's
    // project scope must be denied by the existing OwnershipPolicy.
    await seed(repo, [
      makeRecord({
        namespace: 'project:1',
        key: 'mine',
        type: MemoryType.Project,
        owner: makeOwner(MemoryOwnerKind.Project, '1'),
        content: 'allowed',
      }),
      makeRecord({
        namespace: 'project:1',
        key: 'not_mine',
        type: MemoryType.Project,
        owner: makeOwner(MemoryOwnerKind.Project, '99'),
        content: 'must not leak',
      }),
    ]);
    const actor = makeActor(MemoryActorGroup.Client, ['project:1'], { projectIds: ['1'] });

    const results = await service.retrieve({ actor, namespace: 'project:1', query: 'test' });

    const keys = results.results.map((r) => r.record.key);
    expect(keys).toContain('mine');
    expect(keys).not.toContain('not_mine');
  });

  it('3. excludes memory above the actor clearance (permissive authorizer)', async () => {
    const { repo, service } = await buildService(allowAllAuthorizer);
    await seed(repo, [
      makeRecord({
        namespace: 'user:1',
        key: 'internal',
        securityLevel: MemorySecurityLevel.Internal,
        content: 'allowed',
      }),
      makeRecord({
        namespace: 'user:1',
        key: 'confidential',
        securityLevel: MemorySecurityLevel.Confidential,
        content: 'must not leak',
      }),
    ]);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Internal,
    });

    const results = await service.retrieve({ actor, namespace: 'user:1', query: 'test' });

    const keys = results.results.map((r) => r.record.key);
    expect(keys).toContain('internal');
    expect(keys).not.toContain('confidential');
  });

  it('4. returns only the authorized subset of mixed candidates', async () => {
    const { repo, service } = await buildService(allowAllAuthorizer);
    await seed(repo, [
      makeRecord({
        namespace: 'user:1',
        key: 'a',
        securityLevel: MemorySecurityLevel.Internal,
        content: 'allowed a',
      }),
      makeRecord({ namespace: 'user:99', key: 'b', content: 'blocked b' }),
      makeRecord({
        namespace: 'user:1',
        key: 'c',
        securityLevel: MemorySecurityLevel.Confidential,
        content: 'blocked c',
      }),
    ]);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Internal,
    });

    const results = await service.retrieve({ actor, namespace: 'user:1', query: 'test' });

    const keys = results.results.map((r) => r.record.key);
    expect(keys).toEqual(['a']);
  });

  it('5. honors multiple-namespace scoping', async () => {
    const { repo, service } = await buildService(allowAllAuthorizer);
    await seed(repo, [
      makeRecord({ namespace: 'user:1', key: 'n1', content: 'ns1' }),
      makeRecord({ namespace: 'user:2', key: 'n2', content: 'ns2' }),
      makeRecord({ namespace: 'project:1', key: 'n3', content: 'project' }),
    ]);
    const actor = makeActor(MemoryActorGroup.Freelancer, ['user:2', 'project:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });

    const results = await service.retrieve({ actor, namespace: 'user:2', query: 'test' });

    const namespaces = results.results.map((r) => r.record.namespace);
    expect(namespaces).not.toContain('user:1');
    expect(namespaces).toContain('user:2');
  });

  it('6. excludes deleted memory', async () => {
    const { repo, service } = await buildService(allowAllAuthorizer);
    await seed(repo, [
      makeRecord({ namespace: 'user:1', key: 'active', content: 'allowed' }),
      makeRecord({
        namespace: 'user:1',
        key: 'deleted',
        lifecycle: MemoryLifecycleState.Deleted,
        content: 'must not leak',
      }),
    ]);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });

    const results = await service.retrieve({ actor, namespace: 'user:1', query: 'test' });

    const keys = results.results.map((r) => r.record.key);
    expect(keys).toContain('active');
    expect(keys).not.toContain('deleted');
  });

  it('7. excludes expired memory', async () => {
    const { repo, service } = await buildService(allowAllAuthorizer);
    await seed(repo, [
      makeRecord({ namespace: 'user:1', key: 'fresh', content: 'allowed' }),
      makeRecord({
        namespace: 'user:1',
        key: 'expired',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:00:01.000Z',
        lifecycle: MemoryLifecycleState.Expired,
        content: 'must not leak',
      }),
    ]);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });

    const results = await service.retrieve({ actor, namespace: 'user:1', query: 'test' });

    const keys = results.results.map((r) => r.record.key);
    expect(keys).toContain('fresh');
    expect(keys).not.toContain('expired');
  });

  it('8. combines authorization + security filtering end to end', async () => {
    const { repo, service } = await buildService(realAuthorizer);
    await seed(repo, [
      makeRecord({
        namespace: 'user:1',
        key: 'internal_owned',
        securityLevel: MemorySecurityLevel.Internal,
        content: 'allowed',
      }),
      makeRecord({
        namespace: 'user:1',
        key: 'confidential_owned',
        securityLevel: MemorySecurityLevel.Confidential,
        content: 'blocked (clearance)',
      }),
      makeRecord({
        namespace: 'user:99',
        key: 'foreign',
        content: 'blocked (scope)',
      }),
    ]);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Internal,
    });

    const results = await service.retrieve({ actor, namespace: 'user:1', query: 'test' });

    const keys = results.results.map((r) => r.record.key);
    expect(keys).toEqual(['internal_owned']);
  });

  it('9. filtered record cannot appear in snippets', async () => {
    const { repo, service } = await buildService(allowAllAuthorizer);
    await seed(repo, [
      makeRecord({
        namespace: 'user:1',
        key: 'confidential',
        securityLevel: MemorySecurityLevel.Confidential,
        content: 'CONFIDENTIAL_CONTENT_MARKER',
      }),
    ]);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Internal,
    });

    const results = await service.retrieve({ actor, namespace: 'user:1', query: 'test' });

    const snippets = results.results.map((r) => r.snippet ?? '').join('|');
    expect(snippets).not.toContain('CONFIDENTIAL_CONTENT_MARKER');
    expect(results.results).toHaveLength(0);
  });

  it('10. filtered record cannot appear in statistics', async () => {
    const { repo, service } = await buildService(allowAllAuthorizer);
    await seed(repo, [
      makeRecord({ namespace: 'user:1', key: 'ok', content: 'allowed' }),
      makeRecord({ namespace: 'user:99', key: 'foreign', content: 'must not leak' }),
    ]);
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });

    const results = await service.retrieve({ actor, namespace: 'user:1', query: 'test' });

    expect(results.statistics.selectedCount).toBe(results.results.length);
    // No result record may reference the out-of-scope namespace.
    for (const r of results.results) {
      expect(r.record.namespace).toBe('user:1');
    }
  });
});

describe('CRIT-1 read path - retrieveMemory enforces security clearance', () => {
  it('excludes CONFIDENTIAL records from an INTERNAL-clearance actor', async () => {
    const { service, repository } = createTestEnv();
    await repository.create(
      makeRecord({
        namespace: 'user:1',
        key: 'internal_rec',
        securityLevel: MemorySecurityLevel.Internal,
        content: 'allowed',
      }),
    );
    await repository.create(
      makeRecord({
        namespace: 'user:1',
        key: 'confidential_rec',
        securityLevel: MemorySecurityLevel.Confidential,
        content: 'CONFIDENTIAL_CLEARANCE_MARKER',
      }),
    );

    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Internal,
    });

    const results = await service.retrieveMemory({ actor, namespace: 'user:1' });
    const keys = results.map((r) => r.record.key);
    expect(keys).toContain('internal_rec');
    expect(keys).not.toContain('confidential_rec');

    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('CONFIDENTIAL_CLEARANCE_MARKER');
  });

  it('denies unauthorized-namespace records even with permissive access policy (defense in depth)', async () => {
    const allowAllAuthorizer: AuthorizationService = {
      name: 'test-allow-all-retrieve',
      authorize: () => ({ allowed: true }),
    };
    const repo = new InMemoryMemoryRepository();
    const service = createRetrievalService({
      repository: repo,
      authorizationService: allowAllAuthorizer,
      clock: undefined,
      logger: undefined,
    });
    await repo.create(
      makeRecord({ namespace: 'user:99', key: 'foreign', content: 'must not leak' }),
    );
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });

    const results = await service.retrieve({ actor, namespace: 'user:1', query: 'test' });
    expect(results.results).toHaveLength(0);
  });
});
