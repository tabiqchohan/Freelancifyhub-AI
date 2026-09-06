import { describe, expect, it } from 'vitest';

import {
  AgentStatus,
  DependencyType,
} from '../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { AgentDefinitionRegistry } from '../../../../src/agents/agent-platform/registry.js';
import { AgentLifecycleState } from '../../../../src/agents/agent-platform/lifecycle.js';
import {
  AgentAlreadyRegisteredError,
  AgentDefinitionInvalidError,
  AgentDependencyCycleError,
  AgentDependencyUnavailableError,
} from '../../../../src/agents/agent-platform/errors.js';
import { AgentExecutionMode } from '../../../../src/agents/agent-platform/types.js';
import { makeDefinition } from './fixtures.js';

describe('AgentDefinitionRegistry', () => {
  it('registers, activates, and reports a healthy snapshot', () => {
    const registry = new AgentDefinitionRegistry();
    registry.registerAgent(makeDefinition(), { activate: true });
    const snap = registry.snapshot();
    expect(snap.registered).toBe(1);
    expect(snap.ready).toBe(1);
    expect(snap.healthy).toBe(true);
    expect(registry.getAgent('AG-222')?.name).toBe('Test Agent 222');
  });

  it('rejects duplicate agent ids', () => {
    const registry = new AgentDefinitionRegistry();
    registry.registerAgent(makeDefinition());
    expect(() => registry.registerAgent(makeDefinition())).toThrow(AgentAlreadyRegisteredError);
  });

  it('re-validates definitions on registration (strict, defaulted)', () => {
    const registry = new AgentDefinitionRegistry();
    expect(() => registry.registerAgent(makeDefinition({ agentId: 'bad-id' }))).toThrow(
      AgentDefinitionInvalidError,
    );
  });

  it('validates declared tools against the tool manager', () => {
    const registry = new AgentDefinitionRegistry({ toolExists: (name) => name === 'memory_read' });
    const good = makeDefinition({ allowedTools: ['memory_read'] });
    registry.registerAgent(good);
    expect(registry.hasAgent('AG-222')).toBe(true);

    expect(() =>
      registry.registerAgent(makeDefinition({ agentId: 'AG-223', allowedTools: ['ghost_tool'] })),
    ).toThrow(/unavailable tools/);
  });

  it('validates required agent dependencies', () => {
    const registry = new AgentDefinitionRegistry();
    const withRequiredDep = makeDefinition({
      dependencies: [{ type: DependencyType.Agent, id: 'AG-999', required: true }],
    });
    expect(() => registry.registerAgent(withRequiredDep)).toThrow(AgentDependencyUnavailableError);
  });

  it('rejects dependency cycles across the full graph', () => {
    const registry = new AgentDefinitionRegistry();
    // AG-101 forwards to a not-yet-registered AG-102 (optional, allowed).
    registry.registerAgent(
      makeDefinition({
        agentId: 'AG-101',
        dependencies: [{ type: DependencyType.Agent, id: 'AG-102', required: false }],
      }),
    );
    expect(registry.hasAgent('AG-101')).toBe(true);
    // AG-102 pointing back to AG-101 closes AG-101 -> AG-102 -> AG-101.
    const backEdge = makeDefinition({
      agentId: 'AG-102',
      dependencies: [{ type: DependencyType.Agent, id: 'AG-101', required: false }],
    });
    expect(() => registry.registerAgent(backEdge)).toThrow(AgentDependencyCycleError);
    // A plain forward-only chain remains valid.
    registry.registerAgent(
      makeDefinition({
        agentId: 'AG-103',
        dependencies: [{ type: DependencyType.Agent, id: 'AG-404', required: false }],
      }),
    );
    expect(registry.hasAgent('AG-103')).toBe(true);
  });

  it('discovers agents by capability, status, execution mode, and readiness', () => {
    const registry = new AgentDefinitionRegistry();
    registry.registerAgent(makeDefinition(), { activate: true });
    expect(registry.findAgentsByCapability('project.read.describe')).toHaveLength(1);
    expect(registry.findAgentsByStatus(AgentStatus.Production)).toHaveLength(1);
    expect(registry.findAgentsByExecutionMode(AgentExecutionMode.Deterministic)).toHaveLength(1);
    expect(registry.findReadyAgents()).toHaveLength(1);

    registry.pauseAgent('AG-222');
    expect(registry.findReadyAgents()).toHaveLength(0);
    expect(
      registry.findAgentsByCapability('project.read.describe', { onlyReady: true }),
    ).toHaveLength(0);
  });

  it('toRoutableAgent reflects live lifecycle availability', () => {
    const registry = new AgentDefinitionRegistry();
    registry.registerAgent(makeDefinition(), { activate: true });
    const routable = registry.toRoutableAgent('AG-222');
    expect(routable?.availability.available).toBe(true);
    expect(routable?.configuration.agentId).toBe('AG-222');

    registry.pauseAgent('AG-222');
    const paused = registry.toRoutableAgent('AG-222');
    expect(paused?.availability.available).toBe(false);
    expect(paused?.availability.reason).toContain('PAUSED');
  });

  it('unregister refuses while executions are in flight', () => {
    const registry = new AgentDefinitionRegistry();
    registry.registerAgent(makeDefinition(), { activate: true });
    registry.lifecycleController.beginExecution('AG-222');
    expect(() => registry.unregisterAgent('AG-222')).toThrow(/active executions/);
    registry.lifecycleController.endExecution('AG-222');
    expect(registry.unregisterAgent('AG-222')).toBe(true);
    expect(registry.hasAgent('AG-222')).toBe(false);
  });

  it('terminate makes the agent unroutable', () => {
    const registry = new AgentDefinitionRegistry();
    registry.registerAgent(makeDefinition(), { activate: true });
    registry.terminateAgent('AG-222');
    expect(registry.lifecycleStateOf('AG-222')).toBe(AgentLifecycleState.Terminated);
    expect(registry.isAgentRoutable('AG-222')).toBe(false);
  });
});
