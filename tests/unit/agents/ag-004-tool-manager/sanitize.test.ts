import { describe, expect, it } from 'vitest';

import { ToolResultStatus } from '../../../../src/agents/ag-004-tool-manager/index.js';
import {
  sanitizeToolOutput,
  toolOutputContainsSecret,
  sanitizeToolResult,
} from '../../../../src/agents/ag-004-tool-manager/utils/sanitize.js';

describe('AG-004 Sanitization', () => {
  it('redacts secret-like values from output', () => {
    const raw = sanitizeToolOutput({ token: 'sk_live_abc123', ok: 7, user: 'alice' });
    const out = (raw ?? {}) as Record<string, unknown>;
    expect(out.ok).toBe(7);
    expect(out.user).toBe('alice');
    expect(String(out.token)).not.toContain('sk_live_abc123');
  });

  it('detects likely secrets', () => {
    expect(toolOutputContainsSecret({ api_key: 'x' })).toBe(true);
    expect(toolOutputContainsSecret({ password: 's3cret' })).toBe(true);
    expect(toolOutputContainsSecret({ name: 'alice', n: 1 })).toBe(false);
  });

  it('produces a sanitized copy of a ToolResult preserving metadata', () => {
    const result = {
      toolId: 'tool:x:v1.0.0',
      toolName: 'x',
      toolVersion: '1.0.0',
      executionId: 'texec_1',
      durationMs: 5,
      status: ToolResultStatus.Success,
      output: { secret: 'postgres://user:pw@host/db', count: 2 } as never,
    } as const;
    const sanitized = sanitizeToolResult(result as never);
    expect(sanitized.toolName).toBe('x');
    expect(sanitized.status).toBe(ToolResultStatus.Success);
    expect(String((sanitized.output as Record<string, unknown>).secret)).not.toContain('pw@');
  });
});
