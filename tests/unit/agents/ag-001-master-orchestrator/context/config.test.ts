import { describe, expect, it } from 'vitest';

import { ContextSectionType } from '../../../../../src/agents/ag-001-master-orchestrator/context/types/index.js';
import {
  parseContextConfig,
  ContextConfigSchema,
} from '../../../../../src/agents/ag-001-master-orchestrator/context/config/index.js';
import { ContextBudgetError } from '../../../../../src/agents/ag-001-master-orchestrator/context/errors/index.js';

describe('parseContextConfig', () => {
  it('applies documented defaults for an empty environment', () => {
    const config = parseContextConfig({});

    expect(config.CONTEXT_VERSION).toBe('context.v1');
    expect(config.CONTEXT_MAX_TOKENS).toBe(8000);
    expect(config.CONTEXT_RESERVED_TOKENS).toBe(200);
    expect(config.CONTEXT_MIN_TOKENS).toBe(200);
    expect(config.CONTEXT_WARNING_THRESHOLD).toBe(0.8);
    expect(config.CONTEXT_OVERFLOW_BEHAVIOR).toBe('truncate');
    expect(config.CONTEXT_DEDUPLICATION_ENABLED).toBe(true);
    expect(config.CONTEXT_COMPRESSION_ENABLED).toBe(true);
    expect(config.CONTEXT_SECTION_ORDER[0]).toBe(ContextSectionType.SYSTEM);
  });

  it('parses explicit values from the environment', () => {
    const config = parseContextConfig({
      CONTEXT_MAX_TOKENS: '1000',
      CONTEXT_RESERVED_TOKENS: '50',
      CONTEXT_MIN_TOKENS: '10',
      CONTEXT_WARNING_THRESHOLD: '0.9',
      CONTEXT_OVERFLOW_BEHAVIOR: 'fail',
      CONTEXT_DEDUPLICATION_ENABLED: 'false',
      CONTEXT_COMPRESSION_ENABLED: 'false',
      CONTEXT_SECTION_ORDER: 'tool,agent,system',
    });

    expect(config.CONTEXT_MAX_TOKENS).toBe(1000);
    expect(config.CONTEXT_RESERVED_TOKENS).toBe(50);
    expect(config.CONTEXT_OVERFLOW_BEHAVIOR).toBe('fail');
    expect(config.CONTEXT_DEDUPLICATION_ENABLED).toBe(false);
    expect(config.CONTEXT_COMPRESSION_ENABLED).toBe(false);
    expect(config.CONTEXT_SECTION_ORDER).toEqual([
      ContextSectionType.TOOL,
      ContextSectionType.AGENT,
      ContextSectionType.SYSTEM,
    ]);
  });

  it('rejects an inconsistent budget (reserved >= max)', () => {
    expect(() =>
      parseContextConfig({
        CONTEXT_MAX_TOKENS: '100',
        CONTEXT_RESERVED_TOKENS: '200',
      }),
    ).toThrow(ContextBudgetError);
  });

  it('rejects an inconsistent budget (min exceeds usable)', () => {
    expect(() =>
      parseContextConfig({
        CONTEXT_MAX_TOKENS: '100',
        CONTEXT_RESERVED_TOKENS: '20',
        CONTEXT_MIN_TOKENS: '100',
      }),
    ).toThrow(ContextBudgetError);
  });

  it('rejects an invalid overflow behavior', () => {
    expect(() => parseContextConfig({ CONTEXT_OVERFLOW_BEHAVIOR: 'panic' })).toThrow(
      ContextBudgetError,
    );
  });
});

describe('ContextConfigSchema', () => {
  it('parses with type coercion and schema defaults', () => {
    const result = ContextConfigSchema.safeParse({ CONTEXT_MAX_TOKENS: '1500' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.CONTEXT_MAX_TOKENS).toBe(1500);
      expect(result.data.CONTEXT_VERSION).toBe('context.v1');
    }
  });

  it('fails for negative max tokens', () => {
    const result = ContextConfigSchema.safeParse({ CONTEXT_MAX_TOKENS: '-5' });

    expect(result.success).toBe(false);
  });
});
