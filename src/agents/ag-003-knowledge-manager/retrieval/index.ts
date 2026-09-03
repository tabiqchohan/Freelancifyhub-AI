import type {
  KnowledgeDocument,
  KnowledgeRetrievalResult,
  ScoreExplanation,
} from '../types/index.js';

/**
 * Deterministic knowledge retrieval engine. Uses lexical/text matching
 * for scoring. Architecture allows future vector/semantic retrieval.
 */

/** Input for a retrieval query. */
export interface KnowledgeRetrievalInput {
  readonly query: string;
  readonly documents: readonly KnowledgeDocument[];
  readonly maxResults?: number;
}

/**
 * Deterministic baseline scorer. Scoring signals:
 * - Title match (exact substring)
 * - Content match (exact substring after normalization)
 * - Source type priority
 * - Version recency
 */
export function scoreDocument(
  document: KnowledgeDocument,
  query: string,
): { score: number; explanations: readonly ScoreExplanation[] } {
  const normalizedQuery = query.toLowerCase().trim();
  const normalizedTitle = document.title.toLowerCase();
  const normalizedContent = document.content.toLowerCase();
  let score = 0;
  const explanations: ScoreExplanation[] = [];

  // Title match
  if (normalizedTitle === normalizedQuery) {
    score += 40;
    explanations.push({
      signal: 'title_exact_match',
      contribution: 40,
      detail: 'Query exactly matches title',
    });
  } else if (normalizedTitle.includes(normalizedQuery)) {
    score += 30;
    explanations.push({
      signal: 'title_contains',
      contribution: 30,
      detail: 'Title contains query',
    });
  }

  // Content match
  if (normalizedContent.includes(normalizedQuery)) {
    const count = normalizedContent.split(normalizedQuery).length - 1;
    const contentScore = Math.min(count * 10, 30);
    score += contentScore;
    explanations.push({
      signal: 'content_match',
      contribution: contentScore,
      detail: `Content contains query ${count} time(s)`,
    });
  }

  // Word overlap
  const queryWords = normalizedQuery.split(/\s+/).filter((w) => w.length > 2);
  const titleWords = normalizedTitle.split(/\s+/);
  const overlapCount = queryWords.filter((w) => titleWords.some((tw) => tw.includes(w))).length;
  if (overlapCount > 0) {
    const wordScore = Math.min(overlapCount * 5, 15);
    score += wordScore;
    explanations.push({
      signal: 'word_overlap',
      contribution: wordScore,
      detail: `${overlapCount} query words in title`,
    });
  }

  // Version recency (higher version = slightly higher score)
  if (document.version > 1) {
    const versionScore = Math.min((document.version - 1) * 2, 10);
    score += versionScore;
    explanations.push({
      signal: 'version_recency',
      contribution: versionScore,
      detail: `Version ${document.version}`,
    });
  }

  return { score, explanations };
}

/**
 * Deterministic retrieval pipeline:
 * candidate retrieval → relevance scoring → ranking → deduplication → limits.
 */
export function retrieveKnowledge(
  input: KnowledgeRetrievalInput,
): readonly KnowledgeRetrievalResult[] {
  const { query, documents, maxResults = 10 } = input;

  if (!query || query.trim().length === 0 || documents.length === 0) {
    return [];
  }

  // Score all documents
  const scored = documents.map((doc) => {
    const { score, explanations } = scoreDocument(doc, query);
    return {
      documentId: doc.id,
      versionId: '',
      title: doc.title,
      content: doc.content,
      namespace: doc.namespace,
      securityLevel: doc.securityLevel,
      source: doc.source,
      score,
      scoreExplanations: explanations,
      version: doc.version,
    };
  });

  // Filter out zero-score documents
  const candidates = scored.filter((s) => s.score > 0);

  // Rank by score descending, then by title ascending for determinism
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.title.localeCompare(b.title);
  });

  // Deduplicate by document ID (keep highest scoring)
  const seen = new Set<string>();
  const deduped: typeof candidates = [];
  for (const item of candidates) {
    if (!seen.has(item.documentId)) {
      seen.add(item.documentId);
      deduped.push(item);
    }
  }

  // Apply limit
  return deduped.slice(0, maxResults);
}
