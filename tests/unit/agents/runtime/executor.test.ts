import { describe, expect, it } from 'vitest';

import { AgentRegistry } from '../../../../src/agents/runtime/registry.js';
import {
  ProductionAgentExecutor,
  ProductionExecutorRegistry,
} from '../../../../src/agents/runtime/executor.js';
import {
  createRuntimeAgent,
  RUNTIME_AGENT_FAILURE_CODE,
} from '../../../../src/agents/runtime/runtime-agent.js';
import { RuntimeAgentEventType } from '../../../../src/agents/runtime/types.js';
import type { AgentExecutionRequest } from '../../../../src/agents/ag-001-master-orchestrator/execution/index.js';
import { FailurePolicy } from '../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import {
  MemoryActorGroup,
  MemorySecurityLevel,
} from '../../../../src/agents/ag-002-memory-manager/index.js';
import type { MemoryContextProvider } from '../../../../src/agents/ag-001-master-orchestrator/context/index.js';
import {
  ContextSourceType,
  ContextSectionType,
  ContextPriority,
} from '../../../../src/agents/ag-001-master-orchestrator/context/index.js';

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
    executionId: 'exec_req-1',
    stepId: 'step-1',
    agentId: 'AG-101',
    inputs: { 'request.input': 'create project' },
    policy,
    traceId: 'trace-1',
    ...overrides,
  };
}

describe('ProductionAgentExecutor', () => {
  it('executes a registered agent successfully', async () => {
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent());
    const executor = new ProductionAgentExecutor({ registry });
    const result = await executor.execute(request());
    expect(result.success).toBe(true);
    expect(asRecord(asRecord(result.output).project).kind).toBe('description');
    expect(result.metadata?.provider).toBe('runtime');
  });

  it('fails closed for an unknown agent (AGENT_NOT_FOUND)', async () => {
    const registry = new AgentRegistry();
    const executor = new ProductionAgentExecutor({ registry });
    const result = await executor.execute(request());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AGENT_NOT_FOUND');
    expect(result.error?.retryable).toBe(false);
  });

  it('fails closed for an unavailable (retired) agent', async () => {
    const agent = createRuntimeAgent();
    const retired = {
      ...agent,
      configuration: { ...agent.configuration, status: 'Retired' as never },
    };
    const registry = new AgentRegistry();
    registry.register(retired);
    const executor = new ProductionAgentExecutor({ registry });
    const result = await executor.execute(request());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AGENT_UNAVAILABLE');
  });

  it('exposes only available agents through the executor registry', async () => {
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent());
    const executor = new ProductionAgentExecutor({ registry });
    const executorRegistry = new ProductionExecutorRegistry(executor);
    expect(executorRegistry.resolve('AG-101')).toBe(executor);
    expect(executorRegistry.resolve('AG-NOPE')).toBeUndefined();
  });

  it('timing out returns a timeout error', async () => {
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent());
    const executor = new ProductionAgentExecutor({
      registry,
      defaultTimeoutMs: 20,
    });
    const result = await executor.execute(
      request({ inputs: { 'request.input': 'x', 'runtime.delayMs': 200 } }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXECUTION_TIMEOUT_ERROR');
  });

  it('propagates deterministic agent failure', async () => {
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent());
    const executor = new ProductionAgentExecutor({ registry });
    const result = await executor.execute(request({ inputs: { 'runtime.fail': true } }));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(RUNTIME_AGENT_FAILURE_CODE);
  });
});

describe('ProductionAgentExecutor - memory provisioning (Phase 5)', () => {
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
    requestId: 'req-1',
    traceId: 'trace-1',
    actorGroup: MemoryActorGroup.Client,
    namespaces: ['user:1'],
  });

  it('provisions memory through the provider into the agent context', async () => {
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent());
    const executor = new ProductionAgentExecutor({
      registry,
      memoryProvider,
      memoryInputBuilder,
    });
    const result = await executor.execute(request({ inputs: { 'request.input': 'x' } }));
    expect(result.success).toBe(true);
    expect(asRecord(result.output).memory).toEqual({ included: 1, namespaces: ['user:1'] });
  });

  it('degrades to empty context when the provider throws', async () => {
    const failing: MemoryContextProvider = {
      source: ContextSourceType.MEMORY,
      load: async () => {
        throw new Error('storage down');
      },
    };
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent());
    const executor = new ProductionAgentExecutor({
      registry,
      memoryProvider: failing,
      memoryInputBuilder,
    });
    const result = await executor.execute(request({ inputs: { 'request.input': 'x' } }));
    expect(result.success).toBe(true);
    expect(asRecord(result.output).memory).toEqual({ included: 0, namespaces: [] });
  });
});

describe('ProductionAgentExecutor - runtime events (Phase 6)', () => {
  it('emits a started and completed event on success', async () => {
    const events: string[] = [];
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent());
    const executor = new ProductionAgentExecutor({
      registry,
      onEvent: (event) => events.push(event.type),
    });
    await executor.execute(request());
    expect(events).toContain(RuntimeAgentEventType.ExecutionStarted);
    expect(events).toContain(RuntimeAgentEventType.ExecutionCompleted);
  });

  it('emits a fail event on agent failure', async () => {
    const events: string[] = [];
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent());
    const executor = new ProductionAgentExecutor({
      registry,
      onEvent: (event) => events.push(event.type),
    });
    await executor.execute(request({ inputs: { 'runtime.fail': true } }));
    expect(events).toContain(RuntimeAgentEventType.ExecutionFailed);
  });
});
