import {
  AgentCategory,
  AgentStatus,
} from '../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { capability } from '../../../../src/agents/agent-platform/schemas.js';
import { AgentExecutionMode } from '../../../../src/agents/agent-platform/types.js';
import type { AgentDefinition } from '../../../../src/agents/agent-platform/types.js';

/** Minimal, valid fixture definition used across platform unit tests. */
export function makeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentId: 'AG-222',
    name: 'Test Agent 222',
    version: '1.0.0',
    description: 'unit fixture',
    team: 'test',
    category: AgentCategory.Core,
    status: AgentStatus.Production,
    capabilities: [capability('project.read.describe')],
    executionModes: [AgentExecutionMode.Deterministic],
    allowedTools: [],
    permissions: ['memory.read'],
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

export function capabilityId(definition: AgentDefinition): string {
  const first = definition.capabilities[0];
  return first === undefined ? '' : first.id;
}
