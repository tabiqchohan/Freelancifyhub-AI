import type { ContextConfig } from '../config/index.js';
import { contextConfig } from '../config/index.js';
import type { TokenEstimator } from '../interfaces/token-estimator.js';
import { CharacterTokenEstimator } from '../interfaces/token-estimator.js';
import { BudgetManager } from '../budget/index.js';
import { ContextCompressorPipeline } from '../compressors/index.js';
import { deduplicateItems } from './deduplicator.js';
import { normalizeItem } from './normalizer.js';
import { orderSections, sortByPriority } from '../prioritizers/index.js';
import type { ContextPriority, ContextSectionType } from '../types/index.js';
import type {
  ContextBudget,
  ContextBuildRequest,
  ContextBuildResult,
  ContextBuildWarning,
  ContextItem,
  ContextSection,
  ContextSnapshot,
  ContextStatistics,
} from '../types/index.js';
import { assertValidBudget, assertValidRequest } from '../validators/index.js';
import { nowIso } from '../../utils/ids.js';
import { DEFAULT_SECTION_ORDER } from '../utils/ordering.js';

export interface ContextBuilderOptions {
  readonly config?: ContextConfig;
  readonly estimator?: TokenEstimator;
  readonly compressor?: ContextCompressorPipeline;
}

/**
 * Deterministic Context Builder Engine (Sprint 3, prompt §4). Same input +
 * same configuration ⇒ same output. The engine never fetches anything; it only
 * assembles the supplied items.
 */
export class ContextBuilder {
  private readonly config: ContextConfig;
  private readonly estimator: TokenEstimator;
  private readonly compressor: ContextCompressorPipeline;
  private readonly budgetManager: BudgetManager;

  constructor(options: ContextBuilderOptions = {}) {
    this.config = options.config ?? contextConfig;
    this.estimator = options.estimator ?? new CharacterTokenEstimator();
    this.budgetManager = new BudgetManager(this.estimator);
    this.compressor =
      options.compressor ?? new ContextCompressorPipeline(this.config.CONTEXT_COMPRESSION_ENABLED);
  }

  build(request: ContextBuildRequest): ContextBuildResult {
    assertValidRequest(request);
    assertValidBudget(request.budget);
    const budget = this.resolveBudget(request.budget);

    const warnings: ContextBuildWarning[] = [];
    const normalized: ContextItem[] = [];
    const totalItems = request.items.length;

    for (const raw of request.items) {
      const item = normalizeItem(raw, warnings);
      if (item !== undefined) {
        normalized.push(item);
      }
    }

    let deduplicated = normalized;
    let deduplicatedCount = 0;

    if (this.config.CONTEXT_DEDUPLICATION_ENABLED) {
      const result = deduplicateItems(normalized);
      deduplicated = [...result.items];
      deduplicatedCount = result.removed;
    }

    const compressed = deduplicated.map((item) => this.compressor.compress(item));
    const applied = this.budgetManager.apply(compressed, budget);

    const sections = this.assembleSections(applied.items);
    const estimatedTokens = this.totalTokens(sections);
    const utilization = estimatedTokens / (budget.maxTokens - budget.reservedTokens);
    const warningsForBuild = this.buildWarnings({
      warnings,
      budget,
      utilization,
      overflowed: applied.overflowed,
    });

    const statistics = this.buildStatistics({
      totalItems,
      includedItems: applied.items.length,
      excludedItems: totalItems - applied.items.length,
      items: applied.items,
      estimatedTokens,
      utilization,
      deduplicatedCount,
      overflowCount: applied.excludedCount,
      warningsCount: warningsForBuild.length,
    });

    const snapshot: ContextSnapshot = {
      version: this.config.CONTEXT_VERSION,
      builtAt: nowIso(),
      requestId: request.requestId,
      traceId: request.traceId,
      sections,
      items: applied.items,
      estimatedTokens,
      budget,
      warnings: warningsForBuild,
      statistics,
    };

    return { snapshot, warnings: warningsForBuild, errors: [], statistics };
  }

  private resolveBudget(override: Partial<ContextBudget> | undefined): ContextBudget {
    const base: ContextBudget = {
      maxTokens: this.config.CONTEXT_MAX_TOKENS,
      reservedTokens: this.config.CONTEXT_RESERVED_TOKENS,
      minTokens: this.config.CONTEXT_MIN_TOKENS,
      warningThreshold: this.config.CONTEXT_WARNING_THRESHOLD,
      overflowBehavior: this.config.CONTEXT_OVERFLOW_BEHAVIOR,
      perSection: {},
    };

    return {
      ...base,
      ...override,
      perSection: { ...base.perSection, ...(override?.perSection ?? {}) },
    };
  }

  private assembleSections(items: readonly ContextItem[]): readonly ContextSection[] {
    const grouped = new Map<ContextSectionType, ContextItem[]>();

    for (const item of items) {
      const list = grouped.get(item.section);
      if (list === undefined) {
        grouped.set(item.section, [item]);
      } else {
        list.push(item);
      }
    }

    const sectionOrder = this.config.CONTEXT_SECTION_ORDER.length
      ? this.config.CONTEXT_SECTION_ORDER
      : DEFAULT_SECTION_ORDER;

    const orderedSections = orderSections([...grouped.keys()], sectionOrder);

    return orderedSections.map((section) => {
      const sectionItems = sortByPriority(grouped.get(section) ?? []);
      return {
        section,
        items: sectionItems,
        estimatedTokens: sectionItems.reduce(
          (sum, item) => sum + this.estimator.estimate(item.content),
          0,
        ),
      };
    });
  }

  private totalTokens(sections: readonly ContextSection[]): number {
    return sections.reduce((sum, section) => sum + section.estimatedTokens, 0);
  }

  private buildWarnings(input: {
    readonly warnings: readonly ContextBuildWarning[];
    readonly budget: ContextBudget;
    readonly utilization: number;
    readonly overflowed: boolean;
  }): readonly ContextBuildWarning[] {
    const warnings = [...input.warnings];

    if (input.utilization >= input.budget.warningThreshold) {
      warnings.push({
        code: 'BUDGET_WARNING',
        message: `Context utilization ${input.utilization.toFixed(2)} exceeds warning threshold ${input.budget.warningThreshold}`,
        details: { utilization: input.utilization },
      });
    }

    if (input.overflowed) {
      warnings.push({
        code: 'CRITICAL_OVERFLOW',
        message: 'CRITICAL context alone exceeds the maximum token budget',
      });
    }

    return warnings;
  }

  private buildStatistics(input: {
    readonly totalItems: number;
    readonly includedItems: number;
    readonly excludedItems: number;
    readonly items: readonly ContextItem[];
    readonly estimatedTokens: number;
    readonly utilization: number;
    readonly deduplicatedCount: number;
    readonly overflowCount: number;
    readonly warningsCount: number;
  }): ContextStatistics {
    const bySource: Partial<Record<ContextItem['source']['type'], number>> = {};
    const byPriority: Partial<Record<ContextPriority, number>> = {};
    const bySection: Partial<Record<ContextSectionType, number>> = {};

    for (const item of input.items) {
      bySource[item.source.type] = (bySource[item.source.type] ?? 0) + 1;
      byPriority[item.priority] = (byPriority[item.priority] ?? 0) + 1;
      bySection[item.section] = (bySection[item.section] ?? 0) + 1;
    }

    return {
      totalItems: input.totalItems,
      includedItems: input.includedItems,
      excludedItems: input.excludedItems,
      itemsBySource: bySource,
      itemsByPriority: byPriority,
      itemsBySection: bySection,
      estimatedTokens: input.estimatedTokens,
      budgetUtilization: input.utilization,
      deduplicatedCount: input.deduplicatedCount,
      overflowCount: input.overflowCount,
      warningsCount: input.warningsCount,
    };
  }
}
