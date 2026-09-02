import { describe, expect, it } from 'vitest';

import {
  createRuntimeAgent,
  summarizeInput,
  RUNTIME_AGENT_FAILURE_CODE,
} from '../../../../src/agents/runtime/runtime-agent.js';
import { MemorySecurityLevel } from '../../../../src/agents/ag-002-memory-manager/index.js';
import type { RuntimeAgentExecutionContext } from '../../../../src/agents/runtime/types.js';

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function context(
  overrides: Partial<RuntimeAgentExecutionContext> = {},
): RuntimeAgentExecutionContext {
  return {
    agentId: 'AG-101',
    executionId: 'exec_req-1',
    stepId: 'step-1',
    traceId: 'trace-1',
    requestId: 'req-1',
    attempt: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    timeoutMs: 5000,
    inputs: { 'request.input': 'create project' },
    memory: [],
    signal: { requested: false, waitForCancellation: () => new Promise(() => undefined) },
    ...overrides,
  };
}

describe('createRuntimeAgent', () => {
  it('produces a deterministic output for project creation', async () => {
    const agent = createRuntimeAgent();
    const result = await agent.execute(context());
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      project: { name: 'AG-101', kind: 'description', summary: 'create project' },
      agent: { agentId: 'AG-101', provider: 'runtime', version: '1.0.0' },
      memory: { included: 0, namespaces: [] },
    });
  });

  it('registers under the AG-101 slot with the catalog capabilities', () => {
    const agent = createRuntimeAgent();
    expect(agent.configuration.agentId).toBe('AG-101');
    expect(agent.configuration.status).toBe('InDevelopment');
    expect(agent.configuration.capabilities.map((c) => c.id)).toEqual([
      'project.create',
      'project.edit',
      'project.delete',
      'project.view',
    ]);
    expect(agent.configuration.category).toBe('Client');
    expect(agent.availability.available).toBe(true);
  });

  it('read the memory items into namespaces when provided', async () => {
    const agent = createRuntimeAgent();
    const result = await agent.execute(
      context({
        memory: [
          {
            id: 'm1',
            namespace: 'user:1',
            key: 'k1',
            content: 'preference',
            priority: 'High',
            source: 'memory',
            securityLevel: MemorySecurityLevel.Confidential,
            tokenEstimate: 3,
          },
        ],
      }),
    );
    expect(asRecord(result.output).memory).toEqual({
      included: 1,
      namespaces: ['user:1'],
    });
  });

  it('honours the runtime.fail knob deterministically', async () => {
    const agent = createRuntimeAgent();
    const result = await agent.execute(context({ inputs: { 'runtime.fail': true } }));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(RUNTIME_AGENT_FAILURE_CODE);
  });

  it('stops early when cancellation is requested', async () => {
    const agent = createRuntimeAgent();
    const result = await agent.execute(
      context({
        inputs: { 'request.input': 'x', 'runtime.delayMs': 100 },
        signal: { requested: true, waitForCancellation: () => Promise.resolve() },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXECUTION_CANCELLED');
  });

  it('collapses whitespace in the input summary', () => {
    expect(summarizeInput('  a   b  c ')).toBe('a b c');
    expect(summarizeInput('')).toBe('Project description not provided.');
  });
});
