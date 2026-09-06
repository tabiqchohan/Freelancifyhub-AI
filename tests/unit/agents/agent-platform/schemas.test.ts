import { describe, expect, it } from 'vitest';

import {
  AgentCategory,
  AgentStatus,
} from '../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import {
  agentDefinitionSchema,
  capability,
  isValidAgentDefinition,
  parseAgentDefinition,
} from '../../../../src/agents/agent-platform/schemas.js';
import { AGENT_ID_PATTERN } from '../../../../src/agents/agent-platform/constants.js';
import { AgentDefinitionInvalidError } from '../../../../src/agents/agent-platform/errors.js';
import { AgentExecutionMode } from '../../../../src/agents/agent-platform/types.js';
import { DEFAULT_AGENT_LIMITS } from '../../../../src/agents/agent-platform/constants.js';
import { DEFAULT_PROJECT_DESCRIPTION_AGENT } from '../../../../src/agents/agent-platform/builtin.js';

describe('agent definition schemas', () => {
  it('validates and applies limits defaults', () => {
    const definition = parseAgentDefinition({
      agentId: 'AG-101',
      name: 'Test Agent',
      version: '1.0.0',
      description: '',
      team: 'core',
      category: AgentCategory.Core,
      status: AgentStatus.Production,
      capabilities: [capability('project.read.describe')],
      executionModes: ['Deterministic'],
      allowedTools: [],
      permissions: [],
      dependencies: [],
      configuration: {},
    });
    expect(definition.limits.maxExecutionTimeMs).toBe(DEFAULT_AGENT_LIMITS.maxExecutionTimeMs);
    expect(definition.limits.maxConcurrentExecutions).toBe(
      DEFAULT_AGENT_LIMITS.maxConcurrentExecutions,
    );
    expect(definition.capabilities[0]?.id).toBe('project.read.describe');
  });

  it('rejects invalid agent ids on parse', () => {
    const attempt = (): unknown =>
      parseAgentDefinition({
        ...DEFAULT_PROJECT_DESCRIPTION_AGENT,
        agentId: 'AG-1',
      });
    expect(attempt).toThrow(AgentDefinitionInvalidError);
  });

  it('strict-schema rejects unknown fields (no silent configuration)', () => {
    const attempt = (): unknown =>
      parseAgentDefinition({
        ...DEFAULT_PROJECT_DESCRIPTION_AGENT,
        surprise: 'field',
      });
    expect(attempt).toThrow(AgentDefinitionInvalidError);
  });

  it('requires at least one execution mode', () => {
    const attempt = (): unknown =>
      parseAgentDefinition({
        ...DEFAULT_PROJECT_DESCRIPTION_AGENT,
        executionModes: [],
      });
    expect(attempt).toThrow(AgentDefinitionInvalidError);
  });

  it('isValidAgentDefinition is boolean-safe', () => {
    expect(isValidAgentDefinition(DEFAULT_PROJECT_DESCRIPTION_AGENT)).toBe(true);
    expect(isValidAgentDefinition({ nope: true })).toBe(false);
    expect(isValidAgentDefinition(undefined)).toBe(false);
  });

  it('definition schema parses the builtin agent version/grouping cleanly', () => {
    const parsed = agentDefinitionSchema.safeParse(DEFAULT_PROJECT_DESCRIPTION_AGENT);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.agentId).toBe('AG-101');
    }
  });
});

describe('agent id pattern', () => {
  it('matches the AG-NNN convention', () => {
    expect(AGENT_ID_PATTERN.test('AG-101')).toBe(true);
    expect(AGENT_ID_PATTERN.test('XY-1234')).toBe(true);
    expect(AGENT_ID_PATTERN.test('AG-1')).toBe(false);
    expect(AGENT_ID_PATTERN.test('ag-101')).toBe(false);
    expect(AGENT_ID_PATTERN.test('AG-01')).toBe(false);
  });
});

describe('AgentExecutionMode', () => {
  it('orders modes deterministically', () => {
    expect(AgentExecutionMode.Deterministic).toBe('Deterministic');
    expect(AgentExecutionMode.Reasoning).toBe('Reasoning');
    expect(AgentExecutionMode.Agentic).toBe('Agentic');
  });
});
