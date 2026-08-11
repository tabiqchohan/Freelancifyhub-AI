import { describe, expect, it } from 'vitest';

import { CharacterTokenEstimator } from '../../../../../src/agents/ag-001-master-orchestrator/context/interfaces/token-estimator.js';
import {
  DeterministicCompressor,
  NullCompressor,
} from '../../../../../src/agents/ag-001-master-orchestrator/context/interfaces/compressor.js';
import { ContextCompressorPipeline } from '../../../../../src/agents/ag-001-master-orchestrator/context/compressors/index.js';
import {
  orderSections,
  sortByPriority,
} from '../../../../../src/agents/ag-001-master-orchestrator/context/prioritizers/index.js';
import {
  BudgetManager,
  compareByPriority,
} from '../../../../../src/agents/ag-001-master-orchestrator/context/budget/index.js';
import {
  PRIORITY_RANK,
  SOURCE_RANK,
} from '../../../../../src/agents/ag-001-master-orchestrator/context/utils/ordering.js';
import {
  ContextPriority,
  ContextSectionType,
  ContextSourceType,
  type ContextBudget,
  type ContextItem,
} from '../../../../../src/agents/ag-001-master-orchestrator/context/types/index.js';
import { ContextOverflowError } from '../../../../../src/agents/ag-001-master-orchestrator/context/errors/index.js';

function item(overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    id: '1',
    source: { type: ContextSourceType.REQUEST },
    section: ContextSectionType.REQUEST,
    content: 'hello world',
    priority: ContextPriority.NORMAL,
    ...overrides,
  };
}

const estimator = new CharacterTokenEstimator();

function budget(overrides: Partial<ContextBudget> = {}): ContextBudget {
  return {
    maxTokens: 200,
    reservedTokens: 20,
    minTokens: 10,
    warningThreshold: 0.8,
    overflowBehavior: 'truncate',
    perSection: {},
    ...overrides,
  };
}

describe('CharacterTokenEstimator', () => {
  it('estimates ~4 characters per token', () => {
    expect(estimator.estimate('abcd')).toBe(1);
    expect(estimator.estimate('abcdefgh')).toBe(2);
    expect(estimator.estimate('a'.repeat(10))).toBe(3);
  });

  it('returns zero for empty content', () => {
    expect(estimator.estimate('')).toBe(0);
  });

  it('is deterministic', () => {
    const content = 'the quick brown fox jumps over the lazy dog';
    expect(estimator.estimate(content)).toBe(estimator.estimate(content));
  });
});

describe('compressors', () => {
  it('collapses runs of whitespace deterministically', () => {
    const compressor = new DeterministicCompressor();
    expect(compressor.compress('hello   world \n tab')).toBe('hello world tab');
    expect(compressor.compress('  leading')).toBe('leading');
    expect(compressor.compress('trailing  ')).toBe('trailing');
  });

  it('NullCompressor returns content unchanged', () => {
    const compressor = new NullCompressor();
    expect(compressor.compress('hello   world')).toBe('hello   world');
  });

  it('pipeline compresses when enabled', () => {
    const pipeline = new ContextCompressorPipeline(true);
    const out = pipeline.compress(item({ content: 'a  b   c' }));

    expect(out.content).toBe('a b c');
    expect(out.id).toBe('1');
  });

  it('pipeline leaves content unchanged when disabled', () => {
    const pipeline = new ContextCompressorPipeline(false);
    const out = pipeline.compress(item({ content: 'a  b' }));

    expect(out.content).toBe('a  b');
  });
});

describe('compareItems', () => {
  it('orders by priority', () => {
    const sorted = sortByPriority([
      item({ id: 'low', priority: ContextPriority.LOW }),
      item({ id: 'critical', priority: ContextPriority.CRITICAL }),
      item({ id: 'normal', priority: ContextPriority.NORMAL }),
    ]);

    expect(sorted.map((i) => i.id)).toEqual(['critical', 'normal', 'low']);
  });

  it('orders by explicit order within the same priority', () => {
    const sorted = sortByPriority([item({ id: 'b', order: 2 }), item({ id: 'a', order: 1 })]);

    expect(sorted.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('orders by source rank as a tie-break', () => {
    const sorted = sortByPriority([
      item({ id: 'request', source: { type: ContextSourceType.REQUEST } }),
      item({ id: 'agent', source: { type: ContextSourceType.AGENT } }),
    ]);

    expect(sorted.map((i) => i.id)).toEqual(['request', 'agent']);
  });

  it('compareByPriority sorts stable within the same priority/order', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    expect(compareByPriority(a, b)).toBe(0);
  });

  it('PRIORITY_RANK and SOURCE_RANK are exhaustive', () => {
    expect(Object.values(ContextPriority).every((p) => PRIORITY_RANK[p] !== undefined)).toBe(true);
    expect(Object.values(ContextSourceType).every((s) => SOURCE_RANK[s] !== undefined)).toBe(true);
  });
});

describe('orderSections', () => {
  it('honours the configured order', () => {
    const ordered = orderSections(
      [ContextSectionType.TOOL, ContextSectionType.USER, ContextSectionType.SYSTEM],
      [ContextSectionType.SYSTEM, ContextSectionType.USER, ContextSectionType.TOOL],
    );

    expect(ordered).toEqual([
      ContextSectionType.SYSTEM,
      ContextSectionType.USER,
      ContextSectionType.TOOL,
    ]);
  });

  it('keeps unknown sections after known ones, deterministically', () => {
    const unknown = 'unknown-section' as ContextSectionType;
    const ordered = orderSections([unknown, ContextSectionType.USER], [ContextSectionType.USER]);

    expect(ordered).toEqual([ContextSectionType.USER, unknown]);
  });
});

describe('BudgetManager', () => {
  it('includes everything that fits', () => {
    const manager = new BudgetManager(estimator);
    const result = manager.apply(
      [item({ id: 'a', content: 'a'.repeat(80) }), item({ id: 'b', content: 'b'.repeat(80) })],
      budget(),
    );

    expect(result.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.excludedCount).toBe(0);
    expect(result.estimatedTokens).toBe(40);
  });

  it('drops low-priority items first when over budget', () => {
    const manager = new BudgetManager(estimator);
    const result = manager.apply(
      [
        item({ id: 'crit', priority: ContextPriority.CRITICAL, content: 'a'.repeat(160) }),
        item({ id: 'high', priority: ContextPriority.HIGH, content: 'b'.repeat(160) }),
        item({ id: 'opt', priority: ContextPriority.OPTIONAL, content: 'c'.repeat(160) }),
      ],
      budget({ maxTokens: 100, reservedTokens: 10 }),
    );

    expect(result.items.map((i) => i.id)).toEqual(['crit', 'high']);
    expect(result.excludedCount).toBe(1);
    expect(result.overflowed).toBe(false);
  });

  it('never drops CRITICAL items but flags an overflow', () => {
    const manager = new BudgetManager(estimator);
    const result = manager.apply(
      [
        item({ id: 'crit1', priority: ContextPriority.CRITICAL, content: 'a'.repeat(400) }),
        item({ id: 'crit2', priority: ContextPriority.CRITICAL, content: 'b'.repeat(400) }),
      ],
      budget({ maxTokens: 100, reservedTokens: 10 }),
    );

    expect(result.items.map((i) => i.id)).toEqual(['crit1', 'crit2']);
    expect(result.overflowed).toBe(true);
  });

  it('throws ContextOverflowError in fail mode', () => {
    const manager = new BudgetManager(estimator);
    expect(() =>
      manager.apply(
        [item({ id: 'crit', priority: ContextPriority.CRITICAL, content: 'a'.repeat(400) })],
        budget({ maxTokens: 100, reservedTokens: 10, overflowBehavior: 'fail' }),
      ),
    ).toThrow(ContextOverflowError);
  });

  it('respects per-section caps', () => {
    const manager = new BudgetManager(estimator);
    const result = manager.apply(
      [
        item({ id: 'a', section: ContextSectionType.USER, content: 'a'.repeat(80) }),
        item({ id: 'b', section: ContextSectionType.USER, content: 'b'.repeat(80) }),
      ],
      budget({ perSection: { [ContextSectionType.USER]: 20 } }),
    );

    expect(result.items).toHaveLength(1);
    expect(result.excludedCount).toBe(1);
  });

  it('rejects an invalid budget', () => {
    const manager = new BudgetManager(estimator);
    expect(() => manager.apply([item()], budget({ maxTokens: 0 }))).toThrow();
    expect(() =>
      manager.apply([item()], budget({ reservedTokens: 500, maxTokens: 100 })),
    ).toThrow();
  });
});
