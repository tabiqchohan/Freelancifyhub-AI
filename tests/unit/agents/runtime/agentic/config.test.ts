import { describe, expect, it } from 'vitest';

import {
  parseAgenticConfig,
  defaultAgenticConfig,
  agenticLimitSummary,
  AgenticConfigSchema,
} from '../../../../../src/agents/runtime/agentic/config.js';

describe('agentic config (Sprint 18)', () => {
  it('applies safe defaults when nothing is configured', () => {
    const config = parseAgenticConfig({});
    expect(config.AGENTIC_MAX_TURNS).toBe(8);
    expect(config.AGENTIC_MAX_TOOL_CALLS).toBe(6);
    expect(config.AGENTIC_MAX_TOOL_CALLS_PER_TURN).toBe(1);
    expect(config.AGENTIC_MAX_TOOL_RESULT_BYTES).toBe(8 * 1024);
    expect(config.AGENTIC_MAX_TOOL_CONTEXT_BYTES).toBe(24 * 1024);
    expect(config.AGENTIC_MAX_TOTAL_MS).toBe(60_000);
    expect(config.AGENTIC_MAX_REASONING_CALLS).toBe(12);
    expect(config.AGENTIC_MAX_TOKEN_BUDGET).toBe(8_000);
  });

  it('parses numeric values from a raw process env', () => {
    const config = parseAgenticConfig({
      AGENTIC_MAX_TURNS: '3',
      AGENTIC_MAX_TOOL_CALLS: '4',
      AGENTIC_MAX_TOTAL_MS: '500',
    });
    expect(config.AGENTIC_MAX_TURNS).toBe(3);
    expect(config.AGENTIC_MAX_TOOL_CALLS).toBe(4);
    expect(config.AGENTIC_MAX_TOTAL_MS).toBe(500);
  });

  it('ignores unrelated env keys', () => {
    const config = parseAgenticConfig({ LLM_ENABLED: 'true', AGENTIC_MAX_TURNS: '2' });
    expect(config.AGENTIC_MAX_TURNS).toBe(2);
  });

  it('fails fast on out-of-range values', () => {
    expect(() => parseAgenticConfig({ AGENTIC_MAX_TURNS: '0' })).toThrow();
    expect(() => parseAgenticConfig({ AGENTIC_MAX_TURNS: '101' })).toThrow();
    expect(() => parseAgenticConfig({ AGENTIC_MAX_TOOL_RESULT_BYTES: '0' })).toThrow();
    expect(() => parseAgenticConfig({ AGENTIC_MAX_TOKEN_BUDGET: '0' })).toThrow();
  });

  it('fails fast on non-numeric values', () => {
    expect(() => parseAgenticConfig({ AGENTIC_MAX_TURNS: 'lots' })).toThrow();
  });

  it('defaultAgenticConfig equals the schema default', () => {
    expect(defaultAgenticConfig()).toEqual(AgenticConfigSchema.parse({}));
  });

  it('agenticLimitSummary exposes safe numeric limits only', () => {
    const summary = agenticLimitSummary(defaultAgenticConfig());
    expect(summary.maxTurns).toBe(8);
    expect(summary.maxTotalMs).toBe(60_000);
    expect(Object.values(summary).every((v) => typeof v === 'number')).toBe(true);
    expect(Object.keys(summary).sort()).toEqual([
      'maxReasoningCalls',
      'maxTokenBudget',
      'maxToolCalls',
      'maxToolCallsPerTurn',
      'maxToolContextBytes',
      'maxToolResultBytes',
      'maxTotalMs',
      'maxTurns',
    ]);
  });
});
