import { describe, expect, it } from 'vitest';

import { ContextBuilder } from '../../../../../src/agents/ag-001-master-orchestrator/context/builders/index.js';
import {
  ContextPriority,
  ContextSectionType,
  ContextSourceType,
  type ContextItemInput,
} from '../../../../../src/agents/ag-001-master-orchestrator/context/types/index.js';
import { parseContextConfig } from '../../../../../src/agents/ag-001-master-orchestrator/context/config/index.js';
import type { ContextConfig } from '../../../../../src/agents/ag-001-master-orchestrator/context/config/index.js';

function item(overrides: Partial<ContextItemInput> = {}): ContextItemInput {
  return {
    id: '1',
    source: { type: ContextSourceType.REQUEST },
    section: ContextSectionType.REQUEST,
    content: 'hello world',
    priority: ContextPriority.NORMAL,
    ...overrides,
  };
}

function smallConfig(overrides: Partial<Record<string, string>> = {}): ContextConfig {
  return parseContextConfig({
    CONTEXT_MAX_TOKENS: '200',
    CONTEXT_RESERVED_TOKENS: '20',
    CONTEXT_MIN_TOKENS: '10',
    CONTEXT_WARNING_THRESHOLD: '0.8',
    ...overrides,
  });
}

const builder = (config?: ContextConfig) => new ContextBuilder({ config });

describe('ContextBuilder basics', () => {
  it('builds an empty snapshot for empty context', () => {
    const result = builder().build({ items: [] });

    expect(result.snapshot.items).toHaveLength(0);
    expect(result.snapshot.sections).toHaveLength(0);
    expect(result.statistics.totalItems).toBe(0);
    expect(result.statistics.includedItems).toBe(0);
    expect(result.statistics.estimatedTokens).toBe(0);
  });

  it('includes a single item', () => {
    const result = builder().build({ items: [item()] });

    expect(result.snapshot.items).toHaveLength(1);
    expect(result.snapshot.items[0]?.id).toBe('1');
    expect(result.statistics.includedItems).toBe(1);
  });

  it('includes multiple items', () => {
    const result = builder().build({
      items: [
        item({ id: '1', content: 'first item content' }),
        item({ id: '2', content: 'second item content' }),
        item({ id: '3', content: 'third item content' }),
      ],
    });

    expect(result.snapshot.items).toHaveLength(3);
  });

  it('produces deterministic output for the same input', () => {
    const config = smallConfig();
    const input = {
      items: [
        item({ id: 'a', priority: ContextPriority.HIGH }),
        item({ id: 'b', priority: ContextPriority.LOW }),
        item({ id: 'c', priority: ContextPriority.CRITICAL }),
      ],
    };

    const first = builder(config).build(input);
    const second = builder(config).build(input);

    expect(first.snapshot.items.map((i) => i.id)).toEqual(second.snapshot.items.map((i) => i.id));
    expect(first.statistics).toEqual(second.statistics);
    expect(first.snapshot.estimatedTokens).toBe(second.snapshot.estimatedTokens);
  });

  it('propagates request and trace ids', () => {
    const result = builder().build({ requestId: 'req_1', traceId: 'trace_1', items: [] });

    expect(result.snapshot.requestId).toBe('req_1');
    expect(result.snapshot.traceId).toBe('trace_1');
  });
});

describe('priority ordering', () => {
  it('orders items by priority within a section', () => {
    const result = builder().build({
      items: [
        item({ id: 'low', priority: ContextPriority.LOW }),
        item({ id: 'critical', priority: ContextPriority.CRITICAL }),
        item({ id: 'normal', priority: ContextPriority.NORMAL }),
      ],
    });

    expect(result.snapshot.items.map((i) => i.id)).toEqual(['critical', 'normal', 'low']);
  });

  it('respects explicit order within the same priority', () => {
    const result = builder().build({
      items: [
        item({ id: 'b', priority: ContextPriority.HIGH, order: 2, content: 'beta content' }),
        item({ id: 'a', priority: ContextPriority.HIGH, order: 1, content: 'alpha content' }),
      ],
    });

    expect(result.snapshot.items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('orders sections deterministically by default', () => {
    const result = builder().build({
      items: [
        item({ id: 'k', section: ContextSectionType.KNOWLEDGE }),
        item({ id: 'u', section: ContextSectionType.USER }),
        item({ id: 's', section: ContextSectionType.SYSTEM }),
      ],
    });

    expect(result.snapshot.sections.map((s) => s.section)).toEqual([
      ContextSectionType.SYSTEM,
      ContextSectionType.USER,
      ContextSectionType.KNOWLEDGE,
    ]);
  });

  it('honours a custom section order', () => {
    const config = smallConfig({
      CONTEXT_SECTION_ORDER: 'knowledge,user,system',
    });
    const result = builder(config).build({
      items: [
        item({ id: 'k', section: ContextSectionType.KNOWLEDGE }),
        item({ id: 'u', section: ContextSectionType.USER }),
        item({ id: 's', section: ContextSectionType.SYSTEM }),
      ],
    });

    expect(result.snapshot.sections.map((s) => s.section)).toEqual([
      ContextSectionType.KNOWLEDGE,
      ContextSectionType.USER,
      ContextSectionType.SYSTEM,
    ]);
  });

  it('omits empty sections from the snapshot', () => {
    const result = builder().build({
      items: [item({ id: 'u', section: ContextSectionType.USER })],
    });

    expect(result.snapshot.sections.map((s) => s.section)).toEqual([ContextSectionType.USER]);
  });
});

describe('deduplication', () => {
  it('removes equivalent items (same source, section, priority, content)', () => {
    const result = builder().build({
      items: [item({ id: 'a' }), item({ id: 'b', content: 'Hello   World' })],
    });

    expect(result.snapshot.items).toHaveLength(1);
    expect(result.statistics.deduplicatedCount).toBe(1);
  });

  it('keeps distinct items even with equal content but different priority', () => {
    const result = builder().build({
      items: [
        item({ id: 'a', priority: ContextPriority.HIGH }),
        item({ id: 'b', priority: ContextPriority.LOW, content: 'hello world' }),
      ],
    });

    expect(result.snapshot.items).toHaveLength(2);
  });

  it('keeps distinct source ids', () => {
    const result = builder().build({
      items: [
        item({ id: 'a', source: { type: ContextSourceType.REQUEST, id: 'r1' } }),
        item({ id: 'b', source: { type: ContextSourceType.REQUEST, id: 'r2' } }),
      ],
    });

    expect(result.snapshot.items).toHaveLength(2);
  });
});

describe('invalid input handling', () => {
  it('drops items with blank ids and records a warning', () => {
    const result = builder().build({ items: [item({ id: '   ' })] });

    expect(result.snapshot.items).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === 'INVALID_ITEM_ID')).toBe(true);
  });

  it('drops items with empty content', () => {
    const result = builder().build({ items: [item({ content: '   ' })] });

    expect(result.snapshot.items).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === 'INVALID_CONTENT')).toBe(true);
  });

  it('assigns a default priority when omitted', () => {
    const result = builder().build({ items: [item({ priority: undefined })] });

    expect(result.snapshot.items[0]?.priority).toBe(ContextPriority.NORMAL);
  });

  it('normalizes content whitespace', () => {
    const result = builder().build({ items: [item({ content: '  hello   world  ' })] });

    expect(result.snapshot.items[0]?.content).toBe('hello world');
  });

  it('rejects a request without an items array', () => {
    expect(() => builder().build({} as never)).toThrow();
  });
});

describe('statistics', () => {
  it('reports items by source, priority and section', () => {
    const result = builder().build({
      items: [
        item({ id: '1', source: { type: ContextSourceType.USER } }),
        item({ id: '2', source: { type: ContextSourceType.PROJECT } }),
        item({ id: '3', priority: ContextPriority.HIGH }),
      ],
    });

    expect(result.statistics.itemsBySource?.[ContextSourceType.USER]).toBe(1);
    expect(result.statistics.itemsBySource?.[ContextSourceType.PROJECT]).toBe(1);
    expect(result.statistics.itemsByPriority?.[ContextPriority.NORMAL]).toBe(2);
    expect(result.statistics.itemsByPriority?.[ContextPriority.HIGH]).toBe(1);
    expect(result.statistics.itemsBySection?.[ContextSectionType.REQUEST]).toBe(3);
  });

  it('computes a deterministic token estimate and utilization', () => {
    const config = smallConfig();
    const result = builder(config).build({ items: [item({ content: 'a'.repeat(80) })] });

    expect(result.snapshot.estimatedTokens).toBe(20);
    expect(result.statistics.estimatedTokens).toBe(20);
    expect(result.statistics.budgetUtilization).toBeCloseTo(20 / 180, 5);
  });

  it('reports excluded items when the budget trims', () => {
    const config = smallConfig();
    const result = builder(config).build({
      items: [
        item({ id: 'crit', priority: ContextPriority.CRITICAL, content: 'a'.repeat(80) }),
        item({ id: 'opt', priority: ContextPriority.OPTIONAL, content: 'b'.repeat(1000) }),
      ],
    });

    expect(result.snapshot.items.map((i) => i.id)).toEqual(['crit']);
    expect(result.statistics.excludedItems).toBe(1);
    expect(result.statistics.overflowCount).toBe(1);
  });
});
