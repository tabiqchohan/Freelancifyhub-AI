import { describe, expect, it } from 'vitest';

import { AgentRegistry } from '../../../../src/agents/runtime/registry.js';
import { ProductionAgentExecutor } from '../../../../src/agents/runtime/executor.js';
import { createRuntimeAgent } from '../../../../src/agents/runtime/runtime-agent.js';
import type { AgentExecutionRequest } from '../../../../src/agents/ag-001-master-orchestrator/execution/index.js';
import { FailurePolicy } from '../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import { AgentDefinitionRegistry } from '../../../../src/agents/agent-platform/registry.js';
import { AgentPlatformGateway } from '../../../../src/agents/agent-platform/gateway.js';
import { AgentExecutionMode } from '../../../../src/agents/agent-platform/types.js';
import {
  AgentCategory,
  AgentStatus,
} from '../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { capability } from '../../../../src/agents/agent-platform/schemas.js';
import type { AgentDefinition } from '../../../../src/agents/agent-platform/types.js';

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
    executionId: 'exec_platform-1',
    stepId: 'step-1',
    agentId: 'AG-101',
    inputs: { 'request.input': 'create project' },
    policy,
    traceId: 'trace-platform-1',
    ...overrides,
  };
}

/** A platform definition aligned with the runtime AG-101 residential agent so
 * a platform-managed execution can actually pass the gate. */
function platformDefinitionForRuntime(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentId: 'AG-101',
    name: 'Revenue Optimizer',
    version: '1.0.0',
    description: 'platform mirror of the runtime AG-101 agent',
    team: 'core',
    category: AgentCategory.Core,
    status: AgentStatus.Production,
    capabilities: [
      capability('project.create'),
      capability('project.edit'),
      capability('project.delete'),
      capability('project.view'),
    ],
    executionModes: [AgentExecutionMode.Deterministic],
    allowedTools: [],
    permissions: [],
    limits: {
      maxExecutionTimeMs: 30_000,
      maxReasoningTurns: 0,
      maxToolCalls: 0,
      maxContextBytes: 65_536,
      maxOutputBytes: 65_536,
      maxConcurrentExecutions: 1,
    },
    dependencies: [],
    configuration: {},
    ...overrides,
  };
}

function makePlatform(options: { definition?: AgentDefinition } = {}) {
  const registry = new AgentDefinitionRegistry();
  registry.registerAgent(options.definition ?? platformDefinitionForRuntime(), {
    activate: true,
  });
  const gateway = new AgentPlatformGateway({ registry });
  return { registry, gateway };
}

describe('ProductionAgentExecutor x AgentPlatformGateway (Sprint 19)', () => {
  it('grants a slot for a platform-managed agent and closes the lease', async () => {
    const runtime = new AgentRegistry();
    runtime.register(createRuntimeAgent());
    const { registry, gateway } = makePlatform();
    const executor = new ProductionAgentExecutor({ registry: runtime, agentPlatform: gateway });

    const result = await executor.execute(request());
    expect(result.success).toBe(true);
    // Lease was closed: the lifecycle returns to READY and active count is 0.
    expect(registry.lifecycleStateOf('AG-101')?.toString()).toBe('READY');
    expect(registry.lifecycleController.activeExecutionCount('AG-101')).toBe(0);
  });

  it('denies a platform-managed agent that is paused (executor fails closed)', async () => {
    const runtime = new AgentRegistry();
    runtime.register(createRuntimeAgent());
    const { registry, gateway } = makePlatform();
    registry.pauseAgent('AG-101');
    const executor = new ProductionAgentExecutor({ registry: runtime, agentPlatform: gateway });

    const result = await executor.execute(request());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AGENT_NOT_READY');
    expect(result.error?.retryable).toBe(false);
  });

  it('denies a platform-managed agent that does not declare the capabilities', async () => {
    const runtime = new AgentRegistry();
    runtime.register(createRuntimeAgent());
    const { registry, gateway } = makePlatform({
      definition: platformDefinitionForRuntime({
        capabilities: [],
      }),
    });
    const executor = new ProductionAgentExecutor({ registry: runtime, agentPlatform: gateway });

    const result = await executor.execute(request());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AGENT_CAPABILITY_DENIED');
    // A denied admission must not leak a running slot.
    expect(registry.lifecycleController.activeExecutionCount('AG-101')).toBe(0);
  });

  it('leaves unmanaged runtime agents on the legacy path', async () => {
    const runtime = new AgentRegistry();
    runtime.register(createRuntimeAgent());
    const { gateway } = makePlatform({
      definition: platformDefinitionForRuntime({ agentId: 'AG-999' }),
    });
    const executor = new ProductionAgentExecutor({ registry: runtime, agentPlatform: gateway });

    const result = await executor.execute(request());
    expect(result.success).toBe(true);
  });
});
