import { z } from 'zod';

import { ToolCategory } from '../../../../src/agents/ag-004-tool-manager/enums/index.js';
import type {
  ToolSpecification,
  ToolDefinition,
  ToolHandler,
} from '../../../../src/agents/ag-004-tool-manager/types/index.js';
import { createToolId } from '../../../../src/agents/ag-004-tool-manager/utils/ids.js';

/** Minimal echo handler used across test suites. */
export function makeEchoHandler(): ToolHandler {
  return {
    name: 'echo',
    invoke(input: unknown): unknown {
      return input;
    },
  };
}

/** Builds a tool specification for tests. */
export function makeSpec(
  name: string,
  version = '1.0.0',
  overrides: Partial<ToolSpecification> = {},
): ToolSpecification {
  return {
    name,
    description: `Test tool ${name}`,
    version,
    category: ToolCategory.Computation,
    inputSchema: z.object({ value: z.number() }),
    outputSchema: z.object({ value: z.number() }),
    handler: {
      name,
      invoke(input: unknown): unknown {
        return input;
      },
    },
    securityLevel: 'INTERNAL' as ToolDefinition['securityLevel'],
    executionPolicy: {
      timeoutMs: 5_000,
      maxInputBytes: 64 * 1024,
      maxOutputBytes: 128 * 1024,
      retryPolicy: { maxRetries: 0, backoffBaseMs: 50, backoffMaxMs: 500 },
      securityLevel: 'INTERNAL' as ToolDefinition['securityLevel'],
    },
    ...overrides,
  };
}

/** Builds a LiveTool directly for registry tests. */
export function makeLive(
  name: string,
  version = '1.0.0',
): { definition: ToolDefinition; handler: ToolHandler } {
  const at = new Date().toISOString();
  return {
    definition: {
      id: createToolId(name, version),
      name,
      description: `Test tool ${name}`,
      version,
      category: ToolCategory.Computation,
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ value: z.number() }),
      permissions: [],
      securityLevel: 'INTERNAL' as ToolDefinition['securityLevel'],
      executionPolicy: {
        timeoutMs: 5_000,
        maxInputBytes: 64 * 1024,
        maxOutputBytes: 128 * 1024,
        retryPolicy: { maxRetries: 0, backoffBaseMs: 50, backoffMaxMs: 500 },
        securityLevel: 'INTERNAL' as ToolDefinition['securityLevel'],
      },
      enabled: true,
      metadata: {},
      createdAt: at,
      updatedAt: at,
    },
    handler: makeEchoHandler(),
  };
}
