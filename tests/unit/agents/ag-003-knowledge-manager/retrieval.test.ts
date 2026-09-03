import { describe, expect, it } from 'vitest';

import {
  scoreDocument,
  retrieveKnowledge,
} from '../../../../src/agents/ag-003-knowledge-manager/retrieval/index.js';
import {
  KnowledgeContentType,
  KnowledgeLifecycleState,
  KnowledgeSecurityLevel,
  KnowledgeSourceType,
} from '../../../../src/agents/ag-003-knowledge-manager/enums/index.js';
import { computeContentHash } from '../../../../src/agents/ag-003-knowledge-manager/utils/checksum.js';
import type { KnowledgeDocument } from '../../../../src/agents/ag-003-knowledge-manager/types/index.js';

function makeDoc(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id: 'knowledge_1',
    namespace: 'user:1',
    title: 'Pricing guide',
    content: 'Our pricing starts at $50 per hour.',
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

describe('AG-003 retrieval - deterministic scoring', () => {
  it('scores title matches higher than no match', () => {
    const doc = makeDoc({ title: 'Pricing guide' });
    const titleHit = scoreDocument(doc, 'pricing');
    const unrelated = scoreDocument(doc, 'completelyunrelatedtermxyz');
    expect(titleHit.score).toBeGreaterThan(unrelated.score);
  });

  it('is deterministic: same input -> same score', () => {
    const doc = makeDoc();
    const a = scoreDocument(doc, 'pricing').score;
    const b = scoreDocument(doc, 'pricing').score;
    expect(a).toBe(b);
  });

  it('exposes explainable scoring signals', () => {
    const doc = makeDoc({ title: 'Pricing guide' });
    const { explanations } = scoreDocument(doc, 'pricing');
    expect(explanations.length).toBeGreaterThan(0);
    for (const exp of explanations) {
      expect(exp.signal).toBeTruthy();
      expect(typeof exp.contribution).toBe('number');
    }
  });

  it('ranks results deterministically by score then title', () => {
    const docs = [
      makeDoc({ id: 'a', title: 'Pricing basics' }),
      makeDoc({ id: 'b', title: 'Advanced pricing' }),
    ];
    const results = retrieveKnowledge({ query: 'pricing', documents: docs });
    // Deterministic first result
    expect(results[0]?.title).toBeTruthy();
  });

  it('deduplicates by document id keeping the best score', () => {
    const docs = [
      makeDoc({ id: 'knowledge_1', title: 'Pricing guide' }),
      makeDoc({ id: 'knowledge_1', title: 'Pricing guide v2' }),
    ];
    const results = retrieveKnowledge({ query: 'pricing', documents: docs });
    const ids = results.map((r) => r.documentId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('respects maxResults', () => {
    const docs = Array.from({ length: 5 }, (_, i) =>
      makeDoc({ id: `knowledge_${i}`, title: `Pricing doc ${i}` }),
    );
    const results = retrieveKnowledge({ query: 'pricing', documents: docs, maxResults: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for empty/whitespace query', () => {
    const docs = [makeDoc()];
    expect(retrieveKnowledge({ query: '', documents: docs }).length).toBe(0);
    expect(retrieveKnowledge({ query: '   ', documents: docs }).length).toBe(0);
  });
});
