import { describe, expect, it } from 'vitest';

import {
  createKnowledgeRuntimeAgent,
  KNOWLEDGE_AGENT_FAILURE_CODE,
  KNOWLEDGE_RUNTIME_AGENT_ID,
  KNOWLEDGE_RUNTIME_CAPABILITIES,
} from '../../../../src/agents/runtime/knowledge-runtime-agent.js';
import type { RuntimeAgentExecutionContext } from '../../../../src/agents/runtime/types.js';

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function context(
  overrides: Partial<RuntimeAgentExecutionContext> = {},
): RuntimeAgentExecutionContext {
  return {
    agentId: 'AG-003',
    executionId: 'exec_req-1',
    stepId: 'step-1',
    traceId: 'trace-1',
    requestId: 'req-1',
    attempt: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    timeoutMs: 5000,
    inputs: { 'request.input': 'how do i reset my password' },
    memory: [],
    signal: { requested: false, waitForCancellation: () => new Promise(() => undefined) },
    ...overrides,
  };
}

describe('createKnowledgeRuntimeAgent', () => {
  it('exposes the AG-003 identity and knowledge capabilities', () => {
    const agent = createKnowledgeRuntimeAgent();
    expect(agent.configuration.agentId).toBe(KNOWLEDGE_RUNTIME_AGENT_ID);
    expect(agent.configuration.name).toBe('Knowledge Manager');
    expect(agent.configuration.capabilities.map((c) => c.id)).toEqual(
      KNOWLEDGE_RUNTIME_CAPABILITIES,
    );
    expect(agent.availability.available).toBe(true);
  });

  it('produces a deterministic answer with a bounded source citation', async () => {
    const agent = createKnowledgeRuntimeAgent();
    const result = await agent.execute(context());
    expect(result.success).toBe(true);
    const output = asRecord(result.output);
    expect(output.agent).toEqual({ agentId: 'AG-003', provider: 'runtime', version: '1.0.0' });
    const answer = asRecord(output.answer);
    expect(answer.text).toBe('how do i reset my password');
    expect(answer.confidence).toBe(0.9);
    expect(asRecord(answer.citations as readonly unknown[])[0]).toMatchObject({
      id: 'aios-knowledge-ag-003',
      title: 'Knowledge base index (AG-003)',
    });
  });

  it('reports no citation and zero confidence for an empty query', async () => {
    const agent = createKnowledgeRuntimeAgent();
    const result = await agent.execute(context({ inputs: { 'request.input': '   ' } }));
    expect(result.success).toBe(true);
    const answer = asRecord(asRecord(result.output).answer);
    expect(answer.text).toBe('Project description not provided.');
    expect(answer.confidence).toBe(0);
    expect(answer.citations).toEqual([]);
  });

  it('fails deterministically when runtime.fail is set', async () => {
    const agent = createKnowledgeRuntimeAgent();
    const result = await agent.execute(context({ inputs: { 'runtime.fail': true } }));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(KNOWLEDGE_AGENT_FAILURE_CODE);
  });

  it('returns an execution cancelled error after cancellation', async () => {
    const agent = createKnowledgeRuntimeAgent();
    const result = await agent.execute(
      context({
        signal: { requested: true, waitForCancellation: () => new Promise(() => undefined) },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXECUTION_CANCELLED');
  });

  it('reads request text from the input bucket fallback', async () => {
    const agent = createKnowledgeRuntimeAgent();
    const result = await agent.execute(context({ inputs: { input: 'onboarding guide' } }));
    expect(result.success).toBe(true);
    expect(asRecord(asRecord(result.output).answer).text).toBe('onboarding guide');
  });
});
