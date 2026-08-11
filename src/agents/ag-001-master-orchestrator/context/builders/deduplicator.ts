import type { ContextItem } from '../types/index.js';
import { contentIdentityKey } from '../utils/ordering.js';

/**
 * Deterministic deduplication (prompt §7). Two items are equivalent when they
 * share source type + source id + section + priority + content identity. The
 * first occurrence (by input order) wins; later duplicates are dropped.
 * No semantic similarity or embeddings are used.
 */
export function deduplicateItems(items: readonly ContextItem[]): {
  readonly items: readonly ContextItem[];
  readonly removed: number;
} {
  const seen = new Set<string>();
  const unique: ContextItem[] = [];
  let removed = 0;

  for (const item of items) {
    const key = [
      item.source.type,
      item.source.id ?? '',
      item.section,
      item.priority,
      contentIdentityKey(item.content),
    ].join('|');

    if (seen.has(key)) {
      removed += 1;
      continue;
    }

    seen.add(key);
    unique.push(item);
  }

  return { items: unique, removed };
}
