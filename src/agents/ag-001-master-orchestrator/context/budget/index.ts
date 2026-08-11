import { ContextBudgetError, ContextOverflowError } from '../errors/index.js';
import type { ContextBudget, ContextItem, ContextSectionType } from '../types/index.js';
import { ContextPriority } from '../types/index.js';
import { PRIORITY_RANK } from '../utils/ordering.js';
import type { TokenEstimator } from '../interfaces/token-estimator.js';

export interface BudgetedSection {
  readonly section: ContextSectionType;
  readonly items: readonly ContextItem[];
  readonly tokens: number;
}

export interface BudgetResult {
  readonly items: readonly ContextItem[];
  readonly sections: readonly BudgetedSection[];
  readonly excludedCount: number;
  readonly estimatedTokens: number;
  readonly overflowed: boolean;
}

/** Compares two items by priority then explicit order (stable, no randomness). */
export function compareByPriority(a: ContextItem, b: ContextItem): number {
  const rankA = PRIORITY_RANK[a.priority] ?? PRIORITY_RANK[ContextPriority.OPTIONAL];
  const rankB = PRIORITY_RANK[b.priority] ?? PRIORITY_RANK[ContextPriority.OPTIONAL];

  if (rankA !== rankB) {
    return rankA - rankB;
  }

  return (a.order ?? 0) - (b.order ?? 0);
}

/**
 * Deterministic token-budget enforcer (prompt §9/§10). Items are allocated by
 * priority tier — CRITICAL first, then HIGH, NORMAL, LOW, OPTIONAL — until the
 * total and per-section caps are exhausted. CRITICAL items are never dropped;
 * if CRITICAL context alone exceeds the budget an overflow is signalled.
 */
export class BudgetManager {
  private readonly estimator: TokenEstimator;

  constructor(estimator: TokenEstimator) {
    this.estimator = estimator;
  }

  estimate(content: string): number {
    return this.estimator.estimate(content);
  }

  apply(items: readonly ContextItem[], budget: ContextBudget): BudgetResult {
    this.assertValidBudget(budget);

    const usable = budget.maxTokens - budget.reservedTokens;
    const sorted = [...items].sort(compareByPriority);

    const included: ContextItem[] = [];
    const sectionTokens = new Map<ContextSectionType, number>();
    let totalTokens = 0;
    let excludedCount = 0;
    let criticalOverflow = false;

    const perSection = (section: ContextSectionType): number =>
      budget.perSection[section] ?? Number.POSITIVE_INFINITY;

    for (const item of sorted) {
      const itemTokens = this.estimate(item.content);

      if (item.priority === ContextPriority.CRITICAL) {
        included.push(item);
        totalTokens += itemTokens;
        sectionTokens.set(item.section, (sectionTokens.get(item.section) ?? 0) + itemTokens);
        if (totalTokens > usable) {
          criticalOverflow = true;
        }
        continue;
      }

      const sectionTotal = sectionTokens.get(item.section) ?? 0;
      const fitsTotal = totalTokens + itemTokens <= usable;
      const fitsSection = sectionTotal + itemTokens <= perSection(item.section);

      if (fitsTotal && fitsSection) {
        included.push(item);
        totalTokens += itemTokens;
        sectionTokens.set(item.section, sectionTotal + itemTokens);
      } else {
        excludedCount += 1;
      }
    }

    if (criticalOverflow && budget.overflowBehavior === 'fail') {
      throw new ContextOverflowError('CRITICAL context alone exceeds the maximum token budget');
    }

    const sections = this.groupBySection(included);

    return {
      items: included,
      sections,
      excludedCount,
      estimatedTokens: totalTokens,
      overflowed: criticalOverflow,
    };
  }

  private groupBySection(items: readonly ContextItem[]): readonly BudgetedSection[] {
    const grouped = new Map<ContextSectionType, ContextItem[]>();

    for (const item of items) {
      const list = grouped.get(item.section);
      if (list === undefined) {
        grouped.set(item.section, [item]);
      } else {
        list.push(item);
      }
    }

    return [...grouped.entries()].map(([section, sectionItems]) => ({
      section,
      items: sectionItems,
      tokens: sectionItems.reduce((sum, item) => sum + this.estimate(item.content), 0),
    }));
  }

  private assertValidBudget(budget: ContextBudget): void {
    if (budget.maxTokens <= 0) {
      throw new ContextBudgetError('Budget maxTokens must be positive');
    }

    if (budget.reservedTokens < 0) {
      throw new ContextBudgetError('Budget reservedTokens must be non-negative');
    }

    if (budget.reservedTokens >= budget.maxTokens) {
      throw new ContextBudgetError('Budget reservedTokens must be below maxTokens');
    }
  }
}
