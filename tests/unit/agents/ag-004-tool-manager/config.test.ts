import { describe, expect, it } from 'vitest';

import { parseToolConfig } from '../../../../src/agents/ag-004-tool-manager/config/index.js';
import { ToolConfigSchema } from '../../../../src/agents/ag-004-tool-manager/config/schema.js';
import { ToolConfigurationError } from '../../../../src/agents/ag-004-tool-manager/errors/index.js';

describe('AG-004 Tool Config', () => {
  it('applies safe defaults on empty env', () => {
    const cfg = ToolConfigSchema.parse({});
    expect(cfg.TOOLS_ENABLED).toBe(true);
    expect(cfg.TOOLS_STORAGE_BACKEND).toBe('in-memory');
    expect(cfg.TOOLS_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(cfg.TOOLS_MAX_INPUT_BYTES).toBeGreaterThan(0);
    expect(cfg.TOOLS_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
  });

  it('parses boolean and numeric strings', () => {
    const cfg = ToolConfigSchema.parse({
      TOOLS_ENABLED: 'false',
      TOOLS_STORAGE_BACKEND: 'durable',
      TOOLS_DEFAULT_TIMEOUT_MS: '1234',
      TOOLS_DEFAULT_RETRY_COUNT: '3',
    });
    expect(cfg.TOOLS_ENABLED).toBe(false);
    expect(cfg.TOOLS_STORAGE_BACKEND).toBe('durable');
    expect(cfg.TOOLS_DEFAULT_TIMEOUT_MS).toBe(1234);
    expect(cfg.TOOLS_DEFAULT_RETRY_COUNT).toBe(3);
  });

  it('parseToolConfig throws on invalid numeric values (fail closed)', () => {
    expect(() =>
      parseToolConfig({ TOOLS_DEFAULT_TIMEOUT_MS: 'not-a-number' } as NodeJS.ProcessEnv),
    ).toThrow(ToolConfigurationError);
  });

  it('rejects negative timeout and retry counts', () => {
    expect(() => ToolConfigSchema.parse({ TOOLS_DEFAULT_TIMEOUT_MS: '-5' })).toThrow();
    expect(() => ToolConfigSchema.parse({ TOOLS_DEFAULT_RETRY_COUNT: '-1' })).toThrow();
  });
});
