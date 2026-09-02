import { describe, expect, it } from 'vitest';

import { AgentStatus } from '../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { AgentRegistry } from '../../../../src/agents/runtime/registry.js';
import {
  AgentRegistryError,
  RUNTIME_AGENT_ERROR_CODES,
} from '../../../../src/agents/runtime/errors.js';
import { createRuntimeAgent } from '../../../../src/agents/runtime/runtime-agent.js';
import type { RuntimeAgent } from '../../../../src/agents/runtime/types.js';

describe('AgentRegistry', () => {
  it('registers and resolves agents by id', () => {
    const registry = new AgentRegistry();
    const agent = createRuntimeAgent({ agentId: 'AG-101' });
    registry.register(agent);
    expect(registry.has('AG-101')).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.get('AG-101')).toBe(agent);
    expect(registry.isAvailable('AG-101')).toBe(true);
  });

  it('rejects duplicate agent ids (fail-closed)', () => {
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-101' }));
    const attempt = (): void => registry.register(createRuntimeAgent({ agentId: 'AG-101' }));
    let caught: unknown;
    try {
      attempt();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRegistryError);
    expect((caught as AgentRegistryError).code).toBe(RUNTIME_AGENT_ERROR_CODES.DUPLICATE_AGENT_ID);
  });

  it('marks retired agents unavailable', () => {
    const agent = createRuntimeAgent({ agentId: 'AG-101' });
    const configuration = { ...agent.configuration, status: AgentStatus.Retired };
    const retired: RuntimeAgent = { ...agent, configuration };
    const registry = new AgentRegistry();
    registry.register(retired);
    expect(registry.isAvailable('AG-101')).toBe(false);
    expect(registry.listAvailable()).toHaveLength(0);
  });

  it('unregisters an agent', () => {
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-101' }));
    expect(registry.unregister('AG-101')).toBe(true);
    expect(registry.has('AG-101')).toBe(false);
  });

  it('exposes configurations and capabilities', () => {
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-101' }));
    expect(registry.configurationOf('AG-101')?.agentId).toBe('AG-101');
    expect(registry.capabilitiesOf('AG-101')?.map((c) => c.id)).toEqual([
      'project.create',
      'project.edit',
      'project.delete',
      'project.view',
    ]);
  });
});
