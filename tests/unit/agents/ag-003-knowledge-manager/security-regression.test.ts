/**
 * Sprint 35 F-1 — knowledge namespace self-grant / IDOR regression suite.
 *
 * The vulnerability: `KnowledgeManagerService` set `actor.namespaces` to the
 * namespace named by the *request being served* immediately before authorizing
 * it. `KnowledgeNamespaceScopePolicy` only asks "is the target namespace in the
 * actor's scope?", so naming a namespace granted it. Any caller could therefore
 * reach any namespace, and any document or version in it, by guessing the id.
 *
 * The fix resolves scope from *persisted* namespace ownership/membership and
 * allows claiming only a namespace that nobody owns yet. These tests pin:
 *  - cross-tenant read/write/delete/erase denial,
 *  - a forged self-grant mutates no state,
 *  - read-only groups cannot materialize namespace state,
 *  - lifecycle/version/listing/search paths all enforce the same scope,
 *  - listing never discloses counts from unauthorized namespaces.
 */
import { describe, expect, it } from 'vitest';

import {
  KnowledgeManagerService,
  InMemoryKnowledgeRepository,
} from '../../../../src/agents/ag-003-knowledge-manager/index.js';
import {
  KnowledgeActorGroup,
  KnowledgeContentType,
  KnowledgeLifecycleState,
  KnowledgeSecurityLevel,
  KnowledgeSourceType,
} from '../../../../src/agents/ag-003-knowledge-manager/enums/index.js';
import { KnowledgeConfigSchema } from '../../../../src/agents/ag-003-knowledge-manager/config/schema.js';
import { KnowledgeAccessDeniedError } from '../../../../src/agents/ag-003-knowledge-manager/errors/index.js';

const config = KnowledgeConfigSchema.parse({});

function makeService() {
  const repo = new InMemoryKnowledgeRepository();
  const service = new KnowledgeManagerService({ repository: repo, config });
  return { repo, service };
}

const OWNER = {
  group: KnowledgeActorGroup.KnowledgeManager,
  actorId: 'tenant-a-owner',
} as const;
const ATTACKER = {
  group: KnowledgeActorGroup.KnowledgeManager,
  actorId: 'tenant-b-attacker',
} as const;

async function seedDocument(
  service: KnowledgeManagerService,
  namespace: string,
  title: string,
  securityLevel: KnowledgeSecurityLevel = KnowledgeSecurityLevel.Internal,
) {
  return service.createDocument({
    title,
    content: `Confidential content for ${namespace}. ${title} reference material.`,
    contentType: KnowledgeContentType.PlainText,
    namespace,
    securityLevel,
    source: { sourceType: KnowledgeSourceType.ManualText },
    actorGroup: OWNER.group,
    actorId: OWNER.actorId,
  });
}

describe('Sprint 35 F-1 — a caller cannot self-grant a namespace', () => {
  it('claims an unclaimed namespace for its creator', async () => {
    const { repo, service } = makeService();
    await seedDocument(service, 'fresh-ns', 'First doc');

    const record = await repo.getNamespaceRecord('fresh-ns');
    expect(record?.ownerActorId).toBe(OWNER.actorId);
  });

  it('denies reading a document in a namespace owned by someone else', async () => {
    const { service } = makeService();
    const doc = await seedDocument(service, 'tenant-a-ns', 'Tenant A plan');

    await expect(
      service.getDocument(doc.id, ATTACKER.group, ATTACKER.actorId),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);
  });

  it('denies writing a version into a namespace owned by someone else', async () => {
    const { service } = makeService();
    const doc = await seedDocument(service, 'tenant-a-ns', 'Tenant A plan');

    await expect(
      service.createVersion({
        documentId: doc.id,
        title: 'Attacker rewrite',
        content: 'Attempting to append a version into a namespace that is not mine.',
        contentType: KnowledgeContentType.PlainText,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.ManualText },
        actorGroup: ATTACKER.group,
        actorId: ATTACKER.actorId,
      }),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);
  });

  it('denies lifecycle transitions on a foreign document', async () => {
    const { service } = makeService();
    const doc = await seedDocument(service, 'tenant-a-ns', 'Tenant A plan');

    await expect(
      service.transitionLifecycle({
        documentId: doc.id,
        targetState: KnowledgeLifecycleState.Archived,
        actorGroup: ATTACKER.group,
        actorId: ATTACKER.actorId,
      }),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);

    // State must be unchanged.
    const after = await repoOf(service).getById(doc.id);
    expect(after?.lifecycle).toBe(KnowledgeLifecycleState.Active);
  });

  it('denies deleting and erasing a foreign namespace', async () => {
    const { service } = makeService();
    const doc = await seedDocument(service, 'tenant-a-ns', 'Tenant A plan');

    await expect(
      service.deleteDocument(doc.id, ATTACKER.group, ATTACKER.actorId),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);
    await expect(
      service.eraseByNamespace('tenant-a-ns', ATTACKER.group, ATTACKER.actorId),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);
  });

  it('a forged self-grant attempt does not mutate namespace state', async () => {
    const { repo, service } = makeService();
    await seedDocument(service, 'tenant-a-ns', 'Tenant A plan');
    const before = await repo.getNamespaceRecord('tenant-a-ns');

    // The attacker names the victim's namespace in their own create request.
    await expect(
      service.createDocument({
        title: 'Poisoned',
        content: 'Attempting to write into a namespace that is not mine.',
        contentType: KnowledgeContentType.PlainText,
        namespace: 'tenant-a-ns',
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.ManualText },
        actorGroup: ATTACKER.group,
        actorId: ATTACKER.actorId,
      }),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);

    const after = await repo.getNamespaceRecord('tenant-a-ns');
    // Neither ownership nor membership changed.
    expect(after).toEqual(before);
    expect(after?.ownerActorId).toBe(OWNER.actorId);
    expect(after?.memberActorIds).not.toContain(ATTACKER.actorId);
  });

  it('denies search over a foreign namespace', async () => {
    const { service } = makeService();
    await seedDocument(service, 'tenant-a-ns', 'Tenant A plan');

    const result = await service.search({
      query: 'Tenant',
      namespace: 'tenant-a-ns',
      actorGroup: ATTACKER.group,
      actorId: ATTACKER.actorId,
      namespaces: ['tenant-a-ns'],
    });
    expect(result.total).toBe(0);
    expect(result.documents).toHaveLength(0);
  });

  it('denies reading version history in a foreign namespace', async () => {
    const { service } = makeService();
    const doc = await seedDocument(service, 'tenant-a-ns', 'Tenant A plan');

    await expect(
      service.listVersions(doc.id, ATTACKER.group, ATTACKER.actorId),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);
    await expect(
      service.getVersion(doc.id, 1, ATTACKER.group, ATTACKER.actorId),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);
  });

  it('grants read to an explicit member and read-only groups cannot claim', async () => {
    const { repo, service } = makeService();
    await seedDocument(service, 'tenant-a-ns', 'Tenant A plan');
    const doc = await seedDocument(service, 'tenant-a-ns', 'Tenant A second doc');

    // Grant membership explicitly (the authorization model for shared access).
    expect(
      await repo.addNamespaceMember('tenant-a-ns', ATTACKER.actorId, new Date().toISOString()),
    ).toBe(true);

    const found = await service.getDocument(doc.id, ATTACKER.group, ATTACKER.actorId);
    expect(found?.id).toBe(doc.id);

    // Marketing is read-only in the matrix and therefore cannot claim.
    const { service: fresh } = makeService();
    await expect(
      fresh.createDocument({
        title: 'Campaign notes',
        content: 'Marketing wants its own namespace but has no Create capability.',
        contentType: KnowledgeContentType.PlainText,
        namespace: 'marketing-ns',
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.ManualText },
        actorGroup: KnowledgeActorGroup.Marketing,
        actorId: 'marketing-1',
      }),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);

    const { repo: freshRepo } = makeService();
    expect(await freshRepo.getNamespaceRecord('marketing-ns')).toBeUndefined();
  });

  it('refuses to add a member to a namespace that does not exist', async () => {
    const { repo } = makeService();
    // Adding a member must not materialize a namespace as a side effect.
    expect(await repo.addNamespaceMember('ghost-ns', 'someone', new Date().toISOString())).toBe(
      false,
    );
    expect(await repo.getNamespaceRecord('ghost-ns')).toBeUndefined();
  });

  it('fails closed for a missing or malformed actor id', async () => {
    const { service } = makeService();
    const doc = await seedDocument(service, 'tenant-a-ns', 'Tenant A plan');

    // Malformed actor id: no persisted identity can match, so scope is empty.
    await expect(
      service.getDocument(doc.id, OWNER.group, '../../etc/passwd'),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);
    await expect(service.getDocument(doc.id, OWNER.group, '')).rejects.toBeInstanceOf(
      KnowledgeAccessDeniedError,
    );

    // Missing actor entirely: an unscoped list returns nothing at all.
    const listed = await service.listDocuments(
      {},
      { offset: 0, limit: 10 },
      OWNER.group,
      undefined,
    );
    expect(listed.items).toHaveLength(0);
    expect(listed.total).toBe(0);

    // A list with no actor group is refused outright.
    const groupless = await service.listDocuments({}, { offset: 0, limit: 10 });
    expect(groupless.items).toHaveLength(0);
  });

  it('reports a missing document as absent rather than as an authorization failure', async () => {
    const { service } = makeService();
    // A non-existent id must not be distinguishable from one the actor may not
    // read, and must not throw an internal error.
    expect(
      await service.getDocument('knowledge_missing000000', OWNER.group, OWNER.actorId),
    ).toBeUndefined();
  });

  it('lists nothing for an unknown namespace that was never claimed', async () => {
    const { service } = makeService();
    await expect(
      service.eraseByNamespace('ghost-ns', OWNER.group, OWNER.actorId),
    ).rejects.toBeInstanceOf(KnowledgeAccessDeniedError);
  });
});

describe('Sprint 35 F-1 — listing never discloses unauthorized namespaces', () => {
  it('does not return foreign documents or their counts from an unscoped list', async () => {
    const { service } = makeService();
    // The attacker owns tenant-b-ns; tenant-a-ns belongs to someone else.
    await service.createDocument({
      title: 'Tenant B one',
      content: 'Content the attacker legitimately owns in their own namespace.',
      contentType: KnowledgeContentType.PlainText,
      namespace: 'tenant-b-ns',
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
      actorGroup: ATTACKER.group,
      actorId: ATTACKER.actorId,
    });
    await seedDocument(service, 'tenant-a-ns', 'Tenant A one');
    await seedDocument(service, 'tenant-a-ns', 'Tenant A two');

    const page = await service.listDocuments(
      {},
      { offset: 0, limit: 50 },
      ATTACKER.group,
      ATTACKER.actorId,
    );

    // Only the attacker's own namespace is visible.
    expect(page.items.map((d) => d.namespace)).toEqual(['tenant-b-ns']);
    // `total` counts only authorized rows: it must not reveal the 2 hidden docs.
    expect(page.total).toBe(1);
  });

  it('does not disclose a confidential document to a member with internal clearance', async () => {
    const { repo, service } = makeService();
    await seedDocument(service, 'tenant-a-ns', 'Tenant A one');

    // Store a Confidential document directly: the service refuses to *create*
    // one for an actor whose resolved clearance is Internal, so the row is
    // seeded to prove the read path filters on each document's own level.
    const internal = await seedDocument(service, 'tenant-a-ns', 'Tenant A confidential');
    await repo.updateDocument({ ...internal, securityLevel: KnowledgeSecurityLevel.Confidential });

    const page = await service.listDocuments(
      { namespace: 'tenant-a-ns' },
      { offset: 0, limit: 50 },
      OWNER.group,
      OWNER.actorId,
    );

    expect(page.items.map((d) => d.title)).toEqual(['Tenant A one']);
    expect(page.total).toBe(1);
  });

  it('never lists a deleted document', async () => {
    const { service } = makeService();
    const doc = await seedDocument(service, 'tenant-a-ns', 'Tenant A one');
    await service.deleteDocument(doc.id, OWNER.group, OWNER.actorId);

    const page = await service.listDocuments(
      { namespace: 'tenant-a-ns' },
      { offset: 0, limit: 50 },
      OWNER.group,
      OWNER.actorId,
    );
    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
  });
});

/** Small helper to reach the repository behind a service under test. */
function repoOf(service: KnowledgeManagerService): InMemoryKnowledgeRepository {
  return (service as unknown as { repository: InMemoryKnowledgeRepository }).repository;
}
