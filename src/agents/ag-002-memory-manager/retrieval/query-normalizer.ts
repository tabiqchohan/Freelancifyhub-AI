/**
 * Deterministic query normalization (Sprint 4, prompt §10).
 * Handles whitespace, case, and basic token normalization.
 * Does NOT implement NLP/LLM query understanding.
 */
export interface QueryNormalizer {
  readonly name: string;
  normalize(query: string): string;
}

export class DefaultQueryNormalizer implements QueryNormalizer {
  readonly name = 'default-query-normalizer';

  normalize(query: string): string {
    if (!query || typeof query !== 'string') {
      return '';
    }
    
    return query
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '')  // Remove punctuation but keep alphanumeric and whitespace
      .trim();
  }
}

/**
 * Creates a normalized query or returns undefined if empty after normalization.
 */
export function normalizeQuery(query: string | undefined, normalizer: QueryNormalizer = new DefaultQueryNormalizer()): string | undefined {
  if (!query) return undefined;
  const normalized = normalizer.normalize(query);
  return normalized.length > 0 ? normalized : undefined;
}