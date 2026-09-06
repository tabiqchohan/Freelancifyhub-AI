import { describe, expect, it } from 'vitest';

import { AgentRegistry } from '../../../../src/agents/runtime/registry.js';
import { ProductionAgentExecutor } from '../../../../src/agents/runtime/executor.js';
import { createRuntimeAgent } from '../../../../src/agents/runtime/runtime-agent.js';
import { AgenticLoopService } from '../../../../src/agents/runtime/agentic/loop.js';
import { AgenticConfigSchema } from '../../../../src/agents/runtime/agentic/config.js';
import { LLM_AGENTIC_CAPABILITY } from '../../../../src/llm/constants.js';
import type { AgentExecutionRequest } from '../../../../src/agents/ag-001-master-orchestrator/execution/index.js';
import { FailurePolicy } from '../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import {
  ToolActorGroup,
  type ToolActor,
  type ToolResult,
} from '../../../../src/agents/ag-004-tool-manager/index.js';
import type {
  AIReasoningServiceContract,
  LLMProviderStatus,
  ReasoningRequest,
  ReasoningResult,
  LLMRequestOptions,
} from '../../../../src/llm/types/index.js';
import type {
  AgenticToolCoordinator,
  AgenticToolInfo,
} from '../../../../src/agents/runtime/agentic/tools.js';

const config = AgenticConfigSchema.parse({});

class StubReasoning implements AIReasoningServiceContract {
  readonly id = 'stub-reasoning';
  calls = 0;
  isEnabled(): boolean {
    return true;
  }
  providerInfo(): LLMProviderStatus {
    return { enabled: true, configured: true, provider: 'stub', model: 'stub-model' };
  }
  async reason(_request: ReasoningRequest, _options?: LLMRequestOptions): Promise<ReasoningResult> {
    this.calls += 1;
    return {
      output: JSON.stringify({ type: 'FINAL_RESPONSE', response: 'Agentic final answer.' }),
      provider: 'stub',
      model: 'stub-model',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      latencyMs: 1,
    };
  }
}

class StubCoordinator implements AgenticToolCoordinator {
  get(_name: string): AgenticToolInfo | undefined {
    return undefined;
  }
  list(): readonly AgenticToolInfo[] {
    return [];
  }
  async execute(): Promise<ToolResult> {
    throw new Error('should never execute without a valid decision');
  }
}

const policy = {
  timeoutMs: 5000,
  retry: { maxRetries: 0, retryable: true, backoffMs: 1 },
  failureBehavior: FailurePolicy.FailFast,
  continueOnFailure: false,
  stopOnFailure: true,
  fallbackAllowed: false,
  maxSteps: 1,
  maxTotalExecutionTimeMs: 20000,
};

function request(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    executionId: 'exec_req-agentic',
    stepId: 'step-1',
    agentId: 'AG-103',
    inputs: { 'request.input': 'create a project' },
    policy,
    traceId: 'trace-agentic',
    ...overrides,
  };
}

const actor: ToolActor = {
  group: ToolActorGroup.Orchestrator,
  id: 'agentic-actor',
  namespaces: ['default'],
};

function makeAgenticExecutor(): {
  executor: ProductionAgentExecutor;
  reasoning: StubReasoning;
} {
  const reasoning = new StubReasoning();
  const loop = new AgenticLoopService({
    reasoning,
    tools: new StubCoordinator(),
    config,
    defaultNamespace: 'default',
  });
  const registry = new AgentRegistry();
  registry.register(createRuntimeAgent({ agentId: 'AG-103', requiresAgentic: true }));
  const executor = new ProductionAgentExecutor({
    registry,
    reasoningService: reasoning,
    agenticLoop: loop,
    agenticToolActor: () => actor,
  });
  return { executor, reasoning };
}

describe('ProductionAgentExecutor - agentic mode (Sprint 18)', () => {
  it('routes agentic-capable agents through the loop and returns the final response', async () => {
    const { executor, reasoning } = makeAgenticExecutor();
    const result = await executor.execute(request());

    expect(result.success).toBe(true);
    expect(reasoning.calls).toBe(1);
    const output = (result.output ?? {}) as Record<string, unknown>;
    const reasoningView = (output['reasoning'] ?? {}) as Record<string, unknown>;
    expect(reasoningView['enabled']).toBe(true);
    expect(String(reasoningView['outputPreview'])).toContain('Agentic final answer.');
  });

  it('fails closed with REASONING_UNAVAILABLE when no loop is wired', async () => {
    const reasoning = new StubReasoning();
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-103', requiresAgentic: true }));
    const executor = new ProductionAgentExecutor({ registry, reasoningService: reasoning });

    const result = await executor.execute(request());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REASONING_UNAVAILABLE');
    expect(result.error?.retryable).toBe(false);
  });

  it('keeps deterministic agents untouched', async () => {
    const reasoning = new StubReasoning();
    const loop = new AgenticLoopService({
      reasoning,
      tools: new StubCoordinator(),
      config,
      defaultNamespace: 'default',
    });
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-101' })); // deterministic
    const executor = new ProductionAgentExecutor({
      registry,
      reasoningService: reasoning,
      agenticLoop: loop,
    });

    const result = await executor.execute(
      request({ agentId: 'AG-101', inputs: { 'request.input': 'create project' } }),
    );
    expect(result.success).toBe(true);
    expect(reasoning.calls).toBe(0);
  });

  it('agentic capability is declared on the runtime agent configuration', () => {
    const agent = createRuntimeAgent({ agentId: 'AG-103', requiresAgentic: true });
    const ids = agent.configuration.capabilities.map((c) => c.id);
    expect(ids).toContain(LLM_AGENTIC_CAPABILITY);
  });
});
