import type { ContextItem, ContextSectionType } from '../types/index.js';
import { ContextPriority } from '../types/index.js';
import { PRIORITY_RANK, SOURCE_RANK } from '../utils/ordering.js';

/**
 * Deterministic prioritization strategy (prompt §8). Ordering is:
 * 1. Priority (CRITICAL → HIGH → NORMAL → LOW → OPTIONAL)
 * 2. Explicit `order` hint within the same priority
 * 3. Source rank (tie-break)
 * 4. Stable insertion order
 * Never random.
 */
export function compareItems(a: ContextItem, b: ContextItem): number {
  const priorityDiff =
    (PRIORITY_RANK[a.priority] ?? PRIORITY_RANK[ContextPriority.OPTIONAL]) -
    (PRIORITY_RANK[b.priority] ?? PRIORITY_RANK[ContextPriority.OPTIONAL]);

  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const orderDiff = (a.order ?? 0) - (b.order ?? 0);
  if (orderDiff !== 0) {
    return orderDiff;
  }

  const sourceDiff = SOURCE_RANK[a.source.type] - SOURCE_RANK[b.source.type];
  if (sourceDiff !== 0) {
    return sourceDiff;
  }

  return 0;
}

/** Sorts items deterministically in place by priority. */
export function sortByPriority(items: readonly ContextItem[]): ContextItem[] {
  return [...items].sort(compareItems);
}

/** Returns the stable section order given a configured (or default) order. */
export function orderSections(
  sections: readonly ContextSectionType[],
  configuredOrder: readonly ContextSectionType[],
): readonly ContextSectionType[] {
  const orderIndex = new Map<ContextSectionType, number>();
  configuredOrder.forEach((section, index) => orderIndex.set(section, index));

  return [...sections].sort(
    (a, b) =>
      (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}
