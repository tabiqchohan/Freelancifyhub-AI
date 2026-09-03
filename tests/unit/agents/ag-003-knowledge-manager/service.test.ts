import { describe, expect, it } from 'vitest';

import {
  KnowledgeManagerService,
  InMemoryKnowledgeRepository,
  createKnowledgeEventLog,
} from '../../../../src/agents/ag-003-knowledge-manager/index.js';
import {
  KnowledgeActorGroup,
  KnowledgeContentType,
  KnowledgeLifecycleState,
  KnowledgeSecurityLevel,
  KnowledgeSourceType,
} from '../../../../src/agents/ag-003-knowledge-manager/enums/index.js';
import { KnowledgeConfigSchema } from '../../../../src/agents/ag-003-knowledge-manager/config/schema.js';
import { createTraceId } from '../../../../src/agents/ag-003-knowledge-manager/utils/ids.js';

const config = KnowledgeConfigSchema.parse({});
const ns = 'unit-knowledge';

function makeService() {
  const repo = new InMemoryKnowledgeRepository();
  const events = createKnowledgeEventLog();
  const service = new KnowledgeManagerService({ repository: repo, config, eventLog: events });
  return { repo, events, service };
}
const actor = { group: KnowledgeActorGroup.KnowledgeManager, actorId: 'km-1' };

describe('AG-003 Knowledge Manager Service - end-to-end create/retrieve', () => {
  it('creates a document, chunks it, and retrieves it (Scenario 1)', async () => {
    const { service, events } = makeService();

    const doc = await service.createDocument({
      title: 'How to onboard a client',
      content: 'First, verify the client identity. Then collect the project requirements.',
      contentType: KnowledgeContentType.PlainText,
      namespace: ns,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
      actorGroup: actor.group,
      actorId: actor.actorId,
    });

    expect(doc.id).toMatch(/^knowledge_/);
    expect(doc.version).toBe(1);
    expect(doc.lifecycle).toBe(KnowledgeLifecycleState.Active);

    const versions = await service.listVersions(doc.id);
    expect(versions.length).toBe(1);
    expect(versions[0]?.versionNumber).toBe(1);

    const search = await service.search({
      query: 'onboard',
      namespace: ns,
      actorGroup: actor.group,
      actorId: actor.actorId,
      namespaces: [ns],
    });
    expect(search.total).toBe(1);
    expect(search.documents[0]?.title).toBe('How to onboard a client');

    expect(events.count()).toBeGreaterThan(0);
  });

  it('creates version 2 while version 1 remains immutable (Scenario 2)', async () => {
    const { service } = makeService();

    const doc = await service.createDocument({
      title: 'Pricing guide',
      content: 'Base rate is $50 per hour.',
      contentType: KnowledgeContentType.PlainText,
      namespace: ns,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
      actorGroup: actor.group,
      actorId: actor.actorId,
    });

    const v1 = await service.getVersion(doc.id, 1);
    expect(v1?.contentHash).toBe(doc.contentHash);

    const result = await service.createVersion({
      documentId: doc.id,
      title: 'Pricing guide',
      content: 'Base rate is $60 per hour with a minimum of 4 hours.',
      contentType: KnowledgeContentType.PlainText,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
      actorGroup: actor.group,
      actorId: actor.actorId,
    });

    expect(result.version.versionNumber).toBe(2);
    expect(result.document.version).toBe(2);

    const v1After = await service.getVersion(doc.id, 1);
    expect(v1After?.content).toBe('Base rate is $50 per hour.');
    expect(v1After?.contentHash).toBe(v1?.contentHash);

    const current = (await service.listVersions(doc.id)).at(-1);
    expect(current?.versionNumber).toBe(2);
  });

  it('unauthorized actor is denied (Scenario 3)', async () => {
    // Insert a confidential document directly into the repo (service cannot
    // authorize creation of confidential docs without actor clearance), then
    // verify that an Internal-clearance Client actor cannot read it via search.
    const { service, repo } = makeService();
    const at = '2026-01-01T00:00:00.000Z';
    await repo.create({
      id: 'knowledge_conf_1',
      namespace: ns,
      title: 'Secret project',
      content: 'Confidential strategy details.',
      contentType: KnowledgeContentType.PlainText,
      source: { sourceType: KnowledgeSourceType.System },
      metadata: {},
      lifecycle: KnowledgeLifecycleState.Active,
      securityLevel: KnowledgeSecurityLevel.Confidential,
      version: 1,
      contentHash: 'hash_conf',
      createdAt: at,
      updatedAt: at,
      createdBy: 'admin-1',
      updatedBy: 'admin-1',
      traceId: 'trace-conf',
    });

    // Internal-clearance Client actor search should NOT surface confidential doc
    const search = await service.search({
      query: 'secret',
      namespace: ns,
      actorGroup: KnowledgeActorGroup.Client,
      actorId: 'client-1',
      namespaces: [ns],
    });
    expect(search.total).toBe(0);
  });

  it('archived knowledge is excluded from normal retrieval (Scenario 4)', async () => {
    const { service } = makeService();

    const doc = await service.createDocument({
      title: 'Old policy',
      content: 'This policy is out of date.',
      contentType: KnowledgeContentType.PlainText,
      namespace: ns,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.System },
      actorGroup: actor.group,
      actorId: actor.actorId,
    });

    await service.transitionLifecycle({
      documentId: doc.id,
      targetState: KnowledgeLifecycleState.Archived,
      actorGroup: actor.group,
      actorId: actor.actorId,
      reason: 'out of date',
    });

    const search = await service.search({
      query: 'policy',
      namespace: ns,
      actorGroup: actor.group,
      actorId: actor.actorId,
      namespaces: [ns],
    });
    expect(search.total).toBe(0);
  });

  it('restored knowledge is available again (Scenario 5)', async () => {
    const { service } = makeService();

    const doc = await service.createDocument({
      title: 'Restorable doc',
      content: 'This should come back after restore.',
      contentType: KnowledgeContentType.PlainText,
      namespace: ns,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.System },
      actorGroup: actor.group,
      actorId: actor.actorId,
    });

    await service.transitionLifecycle({
      documentId: doc.id,
      targetState: KnowledgeLifecycleState.Archived,
      actorGroup: actor.group,
      actorId: actor.actorId,
    });

    let search = await service.search({
      query: 'restorable',
      namespace: ns,
      actorGroup: actor.group,
      actorId: actor.actorId,
      namespaces: [ns],
    });
    expect(search.total).toBe(0);

    await service.transitionLifecycle({
      documentId: doc.id,
      targetState: KnowledgeLifecycleState.Active,
      actorGroup: actor.group,
      actorId: actor.actorId,
      reason: 'restore',
    });

    search = await service.search({
      query: 'restorable',
      namespace: ns,
      actorGroup: actor.group,
      actorId: actor.actorId,
      namespaces: [ns],
    });
    expect(search.total).toBe(1);
  });

  it('reject invalid lifecycle transitions (fail-closed)', async () => {
    const { service } = makeService();

    const doc = await service.createDocument({
      title: 'Lifecycle test',
      content: 'Testing transitions.',
      contentType: KnowledgeContentType.PlainText,
      namespace: ns,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.System },
      actorGroup: actor.group,
      actorId: actor.actorId,
    });

    // Deleted is terminal - cannot transition out
    await service.transitionLifecycle({
      documentId: doc.id,
      targetState: KnowledgeLifecycleState.Deleted,
      actorGroup: actor.group,
      actorId: actor.actorId,
    });

    await expect(
      service.transitionLifecycle({
        documentId: doc.id,
        targetState: KnowledgeLifecycleState.Active,
        actorGroup: actor.group,
        actorId: actor.actorId,
      }),
    ).rejects.toThrow();
  });

  it('rejects empty content', async () => {
    const { service } = makeService();
    await expect(
      service.createDocument({
        title: 'Empty',
        content: '   ',
        contentType: KnowledgeContentType.PlainText,
        namespace: ns,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.System },
        actorGroup: actor.group,
        actorId: actor.actorId,
      }),
    ).rejects.toThrow(/empty/i);
  });

  it('emits knowledge.created events', async () => {
    const { service, events } = makeService();
    const before = events.count();
    await service.createDocument({
      title: 'Event test',
      content: 'Emit an event.',
      contentType: KnowledgeContentType.PlainText,
      namespace: ns,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.System },
      actorGroup: actor.group,
      actorId: actor.actorId,
      traceId: createTraceId(),
    });
    expect(events.count()).toBeGreaterThan(before);
  });
});
