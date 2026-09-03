import { describe, expect, it } from 'vitest';

import {
  KnowledgeActorGroup,
  KnowledgeContentType,
  KnowledgeLifecycleState,
  KnowledgeSecurityLevel,
  KnowledgeSourceType,
} from '../../../../src/agents/ag-003-knowledge-manager/enums/index.js';
import { computeContentHash } from '../../../../src/agents/ag-003-knowledge-manager/utils/checksum.js';
import { buildKnowledgeContext } from '../../../../src/agents/ag-003-knowledge-manager/services/context-builder.js';
import { DefaultKnowledgeAuthorizationService } from '../../../../src/agents/ag-003-knowledge-manager/security/index.js';
import type { KnowledgeDocument } from '../../../../src/agents/ag-003-knowledge-manager/types/index.js';

function makeDoc(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id: 'knowledge_1',
    namespace: 'user:1',
    title: 'Doc',
    content: 'Some knowledge content for the agent context.',
    contentType: KnowledgeContentType.PlainText,
    source: { sourceType: KnowledgeSourceType.ManualText },
    metadata: {},
    lifecycle: KnowledgeLifecycleState.Active,
    securityLevel: KnowledgeSecurityLevel.Internal,
    version: 1,
    contentHash: computeContentHash('content'),
    createdAt: at,
    updatedAt: at,
    createdBy: 'sys',
    updatedBy: 'sys',
    traceId: 'trace',
    ...overrides,
  };
}

const authz = new DefaultKnowledgeAuthorizationService();

describe('AG-003 context builder - AG-001 compatibility', () => {
  it('converts knowledge documents into context items', () => {
    const result = buildKnowledgeContext({
      documents: [makeDoc()],
      actorGroup: KnowledgeActorGroup.Client,
      actorId: 'client-1',
      namespaces: ['user:1'],
      authorizationService: authz,
    });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.source).toBe('knowledge');
    expect(result.items[0]?.section).toBe('knowledge');
    expect(result.items[0]?.content).toContain('Some knowledge content');
  });

  it('deduplicates by content hash', () => {
    const docs = [
      makeDoc({ id: 'a', contentHash: 'hash1' }),
      makeDoc({ id: 'b', contentHash: 'hash1' }),
      makeDoc({ id: 'c', contentHash: 'hash2' }),
    ];
    const result = buildKnowledgeContext({
      documents: docs,
      actorGroup: KnowledgeActorGroup.Client,
      actorId: 'client-1',
      namespaces: ['user:1'],
      authorizationService: authz,
    });
    expect(result.items.length).toBe(2);
  });

  it('filters out unauthorized documents (fail-closed)', () => {
    const docs = [
      makeDoc({ id: 'ok', title: 'Ok doc' }),
      makeDoc({ id: 'cross-ns', namespace: 'user:2', title: 'Cross ns' }),
    ];
    const result = buildKnowledgeContext({
      documents: docs,
      actorGroup: KnowledgeActorGroup.Client,
      actorId: 'client-1',
      namespaces: ['user:1'],
      authorizationService: authz,
    });
    // Only the user:1 document passes authorization
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.id).toBe('ok');
  });

  it('enforces token budget', () => {
    const longContent = 'word '.repeat(2000);
    const result = buildKnowledgeContext({
      documents: [makeDoc({ content: longContent })],
      actorGroup: KnowledgeActorGroup.Client,
      actorId: 'client-1',
      namespaces: ['user:1'],
      authorizationService: authz,
      contextBudgetTokens: 100,
    });
    // With a tiny budget and huge content, nothing is included
    expect(result.estimatedTokens).toBeLessThanOrEqual(100);
  });

  it('enforces maxResults', () => {
    const docs = Array.from({ length: 10 }, (_, i) =>
      makeDoc({ id: `doc_${i}`, contentHash: `hash_${i}` }),
    );
    const result = buildKnowledgeContext({
      documents: docs,
      actorGroup: KnowledgeActorGroup.Client,
      actorId: 'client-1',
      namespaces: ['user:1'],
      authorizationService: authz,
      maxResults: 3,
    });
    expect(result.items.length).toBe(3);
  });

  it('preserves metadata and source attribution', () => {
    const doc = makeDoc({ metadata: { framework: 'react' } });
    const result = buildKnowledgeContext({
      documents: [doc],
      actorGroup: KnowledgeActorGroup.Client,
      actorId: 'client-1',
      namespaces: ['user:1'],
      authorizationService: authz,
    });
    expect(result.items[0]?.metadata?.['namespace']).toBe('user:1');
    expect(result.items[0]?.metadata?.['version']).toBe(1);
  });
});
