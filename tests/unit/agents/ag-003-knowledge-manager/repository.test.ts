import { describe, expect, it } from 'vitest';

import { InMemoryKnowledgeRepository } from '../../../../src/agents/ag-003-knowledge-manager/repositories/in-memory.js';
import {
  KnowledgeContentType,
  KnowledgeLifecycleState,
  KnowledgeSecurityLevel,
  KnowledgeSourceType,
} from '../../../../src/agents/ag-003-knowledge-manager/enums/index.js';
import { createKnowledgeId } from '../../../../src/agents/ag-003-knowledge-manager/utils/ids.js';
import { computeContentHash } from '../../../../src/agents/ag-003-knowledge-manager/utils/checksum.js';
import type { KnowledgeDocument } from '../../../../src/agents/ag-003-knowledge-manager/types/index.js';

function makeDoc(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id: createKnowledgeId(),
    namespace: 'user:1',
    title: 'Doc',
    content: 'content',
    contentType: KnowledgeContentType.PlainText,
    source: { sourceType: KnowledgeSourceType.System },
    metadata: {},
    lifecycle: KnowledgeLifecycleState.Active,
    securityLevel: KnowledgeSecurityLevel.Internal,
    version: 1,
    contentHash: computeContentHash('content'),
    createdAt: at,
    updatedAt: at,
    createdBy: 'sys',
    updatedBy: 'sys',
    traceId: 'trace_test',
    ...overrides,
  };
}

describe('AG-003 repository - in-memory semantics', () => {
  it('creates and reads a document', async () => {
    const repo = new InMemoryKnowledgeRepository();
    const doc = makeDoc();
    await repo.create(doc);
    const read = await repo.getById(doc.id);
    expect(read?.title).toBe('Doc');
  });

  it('reads undefined for missing document', async () => {
    const repo = new InMemoryKnowledgeRepository();
    expect(await repo.getById('missing')).toBeUndefined();
  });

  it('rejects duplicate document by namespace+title', async () => {
    const repo = new InMemoryKnowledgeRepository();
    const doc = makeDoc();
    await repo.create(doc);
    await expect(repo.create(makeDoc({ id: createKnowledgeId() }))).rejects.toThrow(
      /already exists/i,
    );
  });

  it('paginates deterministically', async () => {
    const repo = new InMemoryKnowledgeRepository();
    for (let i = 0; i < 5; i++) {
      await repo.create(makeDoc({ id: createKnowledgeId(), title: `Doc ${i}` }));
    }
    const page1 = await repo.list({}, { offset: 0, limit: 2 });
    expect(page1.items.length).toBe(2);
    const page2 = await repo.list({}, { offset: 2, limit: 2 });
    expect(page2.items.length).toBe(2);
    const page3 = await repo.list({}, { offset: 4, limit: 2 });
    expect(page3.items.length).toBe(1);
    expect(page3.hasMore).toBe(false);
  });

  it('filters by namespace and lifecycle', async () => {
    const repo = new InMemoryKnowledgeRepository();
    await repo.create(makeDoc({ id: createKnowledgeId(), namespace: 'user:1' }));
    await repo.create(makeDoc({ id: createKnowledgeId(), namespace: 'user:2' }));
    const ns1 = await repo.list({ namespace: 'user:1' }, { offset: 0, limit: 10 });
    expect(ns1.total).toBe(1);
  });

  it('updates a document', async () => {
    const repo = new InMemoryKnowledgeRepository();
    const doc = makeDoc();
    await repo.create(doc);
    await repo.updateDocument({ ...doc, title: 'Updated' });
    expect((await repo.getById(doc.id))?.title).toBe('Updated');
  });

  it('deletes a document', async () => {
    const repo = new InMemoryKnowledgeRepository();
    const doc = makeDoc();
    await repo.create(doc);
    expect(await repo.deleteDocument(doc.id)).toBe(true);
    expect(await repo.getById(doc.id)).toBeUndefined();
  });

  it('manages versions', async () => {
    const repo = new InMemoryKnowledgeRepository();
    const doc = makeDoc();
    await repo.create(doc);

    const v1 = {
      id: 'kver_1',
      documentId: doc.id,
      versionNumber: 1,
      title: 'Doc',
      content: 'content',
      contentType: KnowledgeContentType.PlainText,
      source: { sourceType: KnowledgeSourceType.System },
      metadata: {},
      securityLevel: KnowledgeSecurityLevel.Internal,
      contentHash: doc.contentHash,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'sys',
      traceId: 'trace_test',
    };
    await repo.createVersion(v1);

    const v2 = { ...v1, id: 'kver_2', versionNumber: 2, content: 'newer' };
    await repo.createVersion(v2);

    expect((await repo.getCurrentVersion(doc.id))?.versionNumber).toBe(2);
    expect((await repo.getVersion(doc.id, 1))?.content).toBe('content');
    expect((await repo.listVersions(doc.id)).length).toBe(2);

    // Duplicate version rejected
    await expect(repo.createVersion(v1)).rejects.toThrow(/already exists/i);
  });

  it('manages chunks', async () => {
    const repo = new InMemoryKnowledgeRepository();
    const doc = makeDoc();
    await repo.create(doc);
    const version = {
      id: 'kver_1',
      documentId: doc.id,
      versionNumber: 1,
      title: 'Doc',
      content: 'content',
      contentType: KnowledgeContentType.PlainText,
      source: { sourceType: KnowledgeSourceType.System },
      metadata: {},
      securityLevel: KnowledgeSecurityLevel.Internal,
      contentHash: doc.contentHash,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'sys',
      traceId: 'trace_test',
    };
    await repo.createVersion(version);

    await repo.createChunks([
      {
        id: 'kchunk_1',
        documentId: doc.id,
        versionId: version.id,
        versionNumber: 1,
        chunkIndex: 0,
        content: 'part a',
        contentHash: computeContentHash('part a'),
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'kchunk_2',
        documentId: doc.id,
        versionId: version.id,
        versionNumber: 1,
        chunkIndex: 1,
        content: 'part b',
        contentHash: computeContentHash('part b'),
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const chunks = await repo.getChunksByVersionId(version.id);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.chunkIndex).toBe(0);
  });
});
