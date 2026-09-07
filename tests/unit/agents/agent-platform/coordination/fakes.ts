import { AgentLifecycleState } from '../../../../../src/agents/agent-platform/lifecycle.js';
import {
  AgentCategory,
  AgentStatus,
} from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { AgentExecutionMode } from '../../../../../src/agents/agent-platform/types.js';
import type { AgentDefinition } from '../../../../../src/agents/agent-platform/types.js';
import type { AgentDefinitionRegistry } from '../../../../../src/agents/agent-platform/registry.js';
import type { AgentPlatformGateway } from '../../../../../src/agents/agent-platform/gateway.js';
import type { ExecutorRegistry } from '../../../../../src/agents/ag-001-master-orchestrator/execution/index.js';

export interface FakeExecutor {
  readonly agentId: string;
  readonly available: boolean;
  canExecute: (agentId: string) => boolean;
  status: () => { available: boolean };
  execute: (request: unknown) => Promise<unknown>;
  cancel: (executionId: string) => Promise<void>;
}

export function makeDefinition(
  agentId: string,
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    agentId,
    name: `Test Agent ${agentId}`,
    version: '1.0.0',
    description: 'coordination unit fixture',
    team: 'test',
    category: AgentCategory.Core,
    status: AgentStatus.Production,
    capabilities: [],
    executionModes: [AgentExecutionMode.Deterministic],
    allowedTools: [],
    permissions: ['memory.read'],
    limits: {
      maxExecutionTimeMs: 30_000,
      maxReasoningTurns: 0,
      maxToolCalls: 0,
      maxContextBytes: 65_536,
      maxOutputBytes: 65_536,
      maxConcurrentExecutions: 4,
    },
    dependencies: [],
    configuration: {},
    ...overrides,
  };
}

export function readableRegistry(agents: readonly AgentDefinition[]): AgentDefinitionRegistry {
  const registry = {
    getAgent: (agentId: string) => agents.find((a) => a.agentId === agentId),
    lifecycleStateOf: (agentId: string) =>
      agents.some((a) => a.agentId === agentId) ? AgentLifecycleState.Ready : undefined,
    lifecycleController: {
      activeExecutionCount: () => 0,
    },
  } as unknown as AgentDefinitionRegistry;
  return registry;
}

export function readableGateway(): AgentPlatformGateway {
  return {} as unknown as AgentPlatformGateway;
}

/** Minimal executor registry that resolves fixed fake executors. */
export function executorRegistryOf(executors: readonly FakeExecutor[]): ExecutorRegistry {
  return {
    resolve: (agentId: string) => executors.find((e) => e.agentId === agentId),
  } as unknown as ExecutorRegistry;
}

/** Executor registry that resolves an executor for any agent. */
export function dummyExecutorRegistry(): ExecutorRegistry {
  return {
    resolve: (agentId: string) => ({
      agentId,
      available: true,
      canExecute: (target: string) => target === agentId,
      status: () => ({ available: true }),
    }),
  } as unknown as ExecutorRegistry;
}
