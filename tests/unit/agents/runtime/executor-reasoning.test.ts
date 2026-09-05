import { describe, expect, it } from 'vitest';

import { AgentRegistry } from '../../../../src/agents/runtime/registry.js';
import { ProductionAgentExecutor } from '../../../../src/agents/runtime/executor.js';
import {
  createRuntimeAgent,
  REASONING_REQUIRED_CODE,
} from '../../../../src/agents/runtime/runtime-agent.js';
import { RuntimeAgentEventType } from '../../../../src/agents/runtime/types.js';
import { AIReasoningService, MockLLMProvider, parseLlmConfig } from '../../../../src/llm/index.js';
import type { AgentExecutionRequest } from '../../../../src/agents/ag-001-master-orchestrator/execution/index.js';
import { FailurePolicy } from '../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import {
  ContextPriority,
  ContextSectionType,
  ContextSourceType,
  type MemoryContextProvider,
} from '../../../../src/agents/ag-001-master-orchestrator/context/index.js';
import {
  MemoryActorGroup,
  MemorySecurityLevel,
} from '../../../../src/agents/ag-002-memory-manager/index.js';

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

const policy = {
  timeoutMs: 5000,
  retry: { maxRetries: 2, retryable: true, backoffMs: 1 },
  failureBehavior: FailurePolicy.FailFast,
  continueOnFailure: false,
  stopOnFailure: true,
  fallbackAllowed: false,
  maxSteps: 1,
  maxTotalExecutionTimeMs: 20000,
};

function request(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    executionId: 'exec_req-reason',
    stepId: 'step-1',
    agentId: 'AG-102',
    inputs: { 'request.input': 'create a project' },
    policy,
    traceId: 'trace-reason',
    ...overrides,
  };
}

const reasoningConfig = parseLlmConfig({
  LLM_ENABLED: 'true',
  LLM_PROVIDER: 'mock',
  LLM_TIMEOUT_MS: '5000',
  LLM_MAX_RETRIES: '0',
});

const disabledConfig = parseLlmConfig({
  LLM_ENABLED: 'false',
  LLM_PROVIDER: 'mock',
});

function buildReasoningService(config = reasoningConfig): {
  service: AIReasoningService;
  provider: MockLLMProvider;
} {
  const provider = new MockLLMProvider({ config });
  const service = new AIReasoningService({ provider, config });
  return { service, provider };
}

describe('ProductionAgentExecutor - reasoning (Sprint 17)', () => {
  it('keeps deterministic agents deterministic without invoking the LLM', async () => {
    const { service, provider } = buildReasoningService();
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent());
    const executor = new ProductionAgentExecutor({ registry, reasoningService: service });

    const result = await executor.execute(
      request({ agentId: 'AG-101', inputs: { 'request.input': 'create project' } }),
    );
    expect(result.success).toBe(true);
    expect(asRecord(result.output).reasoning).toBeUndefined();
    expect(provider.capturedRequests()).toHaveLength(0);
  });

  it('routes reasoning-capable agents through the reasoning service', async () => {
    const { service, provider } = buildReasoningService();
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));
    const executor = new ProductionAgentExecutor({ registry, reasoningService: service });

    const result = await executor.execute(request());
    expect(result.success).toBe(true);
    const output = asRecord(result.output);
    const reasoning = asRecord(output.reasoning);
    expect(reasoning.enabled).toBe(true);
    expect(reasoning.provider).toBe('mock');
    expect(String(reasoning.outputPreview)).toContain('MOCK');
    expect(provider.capturedRequests()).toHaveLength(1);
    expect(provider.capturedRequests()[0]?.messageCount).toBe(2);
  });

  it('fails closed with REASONING_UNAVAILABLE when no reasoning service is wired', async () => {
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));
    const executor = new ProductionAgentExecutor({ registry });

    const result = await executor.execute(request());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REASONING_UNAVAILABLE');
    expect(result.error?.retryable).toBe(false);
  });

  it('fails closed with REASONING_UNAVAILABLE when reasoning is disabled', async () => {
    const { service } = buildReasoningService(disabledConfig);
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));
    const executor = new ProductionAgentExecutor({ registry, reasoningService: service });

    const result = await executor.execute(request());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REASONING_UNAVAILABLE');
  });

  it('fails closed with REASONING_REQUIRED when a reasoning agent runs without context', async () => {
    const agent = createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true });
    const result = await agent.execute({
      agentId: 'AG-102',
      executionId: 'exec_1',
      stepId: 'step-1',
      traceId: 'trace-1',
      requestId: 'req-1',
      attempt: 1,
      startedAt: new Date().toISOString(),
      timeoutMs: 5000,
      inputs: { 'request.input': 'x' },
      memory: [],
      signal: { requested: false, waitForCancellation: async () => undefined },
    });
    expect(result.success).toBe(false);
    expect(asRecord(result.error).code).toBe(REASONING_REQUIRED_CODE);
  });

  it('propagates AG-001 memory context into the reasoning payload', async () => {
    const { service, provider } = buildReasoningService();
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));

    const memoryProvider: MemoryContextProvider = {
      source: ContextSourceType.MEMORY,
      load: async () => [
        {
          id: 'user:1:k1:1',
          source: { type: ContextSourceType.MEMORY, id: 'user:1' },
          section: ContextSectionType.MEMORY,
          content: 'redacted snippet',
          priority: ContextPriority.NORMAL,
          metadata: {
            namespace: 'user:1',
            key: 'k1',
            type: 'preference',
            securityLevel: MemorySecurityLevel.Confidential,
            tokenEstimate: 4,
          },
        },
      ],
    };
    const memoryInputBuilder = () => ({
      requestId: 'req-reason',
      traceId: 'trace-reason',
      actorGroup: MemoryActorGroup.Client,
      namespaces: ['user:1'],
    });

    const executor = new ProductionAgentExecutor({
      registry,
      reasoningService: service,
      memoryProvider,
      memoryInputBuilder,
    });

    const result = await executor.execute(request());
    expect(result.success).toBe(true);
    const reasoning = asRecord(asRecord(result.output).reasoning);
    expect(reasoning.enabled).toBe(true);

    const captured = provider.capturedRequests();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.totalContentChars).toBeGreaterThan('create a project'.length);
  });

  it('emits execution events and records reasoning failures in the event log', async () => {
    const { service } = buildReasoningService(disabledConfig);
    const events: string[] = [];
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));
    const executor = new ProductionAgentExecutor({
      registry,
      reasoningService: service,
      onEvent: (event) => events.push(event.type),
    });

    const result = await executor.execute(request());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REASONING_UNAVAILABLE');
    expect(events).toContain(RuntimeAgentEventType.ExecutionFailed);
  });
});
