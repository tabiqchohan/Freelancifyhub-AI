import { describe, expect, it } from 'vitest';

import {
  RoutingRegistry,
  buildDefaultCatalog,
  requiredCapabilities,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/registry/index.js';
import { RoutingRegistryError } from '../../../../../src/agents/ag-001-master-orchestrator/routing/errors/index.js';
import { IntentId } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { makeRoutableAgent } from './fixtures.js';

describe('RoutingRegistry', () => {
  it('registers and retrieves an agent', () => {
    const registry = new RoutingRegistry([]);
    const agent = makeRoutableAgent();

    registry.register(agent);

    expect(registry.get('AG-101')).toEqual(agent);
  });

  it('lists registered agents', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent({ agentId: 'AG-101' }),
      makeRoutableAgent({ agentId: 'AG-102' }),
    ]);

    expect(
      registry
        .list()
        .map((a) => a.configuration.agentId)
        .sort(),
    ).toEqual(['AG-101', 'AG-102']);
  });

  it('unregisters an agent', () => {
    const registry = new RoutingRegistry([makeRoutableAgent({ agentId: 'AG-101' })]);
    registry.unregister('AG-101');

    expect(registry.get('AG-101')).toBeUndefined();
  });

  it('rejects duplicate agent registration', () => {
    const registry = new RoutingRegistry([makeRoutableAgent({ agentId: 'AG-101' })]);

    expect(() => registry.register(makeRoutableAgent({ agentId: 'AG-101' }))).toThrow(
      RoutingRegistryError,
    );
  });

  it('rejects an invalid agent entry', () => {
    const registry = new RoutingRegistry([]);

    expect(() => registry.register(makeRoutableAgent({ agentId: '', name: 'x' }))).toThrow(
      RoutingRegistryError,
    );

    expect(() =>
      registry.register(makeRoutableAgent({ agentId: 'AG-1', status: 'Nope' as never })),
    ).toThrow(RoutingRegistryError);
  });

  it('builds the default catalog with known agent ids', () => {
    const catalog = buildDefaultCatalog();
    const ids = catalog.map((a) => a.configuration.agentId);

    expect(ids).toContain('AG-001');
    expect(ids).toContain('AG-101');
    expect(ids).toContain('AG-201');
    expect(ids).toContain('AG-301');
    expect(ids).toContain('AG-401');
    expect(ids).toContain('AG-501');
  });

  it('findCandidates returns agents with the required capability', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent({
        agentId: 'AG-101',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
      makeRoutableAgent({
        agentId: 'AG-999',
        capabilities: [{ id: 'unrelated', name: 'x', enabled: true }],
      }),
    ]);

    const candidates = registry.findCandidates(IntentId.CREATE_PROJECT);

    expect(candidates.map((a) => a.configuration.agentId)).toEqual(['AG-101']);
  });

  it('findCandidates returns nothing for an unknown intent capability set', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent({
        agentId: 'AG-101',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
    ]);

    expect(registry.findCandidates(IntentId.SYSTEM)).toHaveLength(0);
  });
});

describe('requiredCapabilities', () => {
  it('maps intents to their required capabilities', () => {
    expect(requiredCapabilities(IntentId.CREATE_PROJECT)).toContain('project.create');
    expect(requiredCapabilities(IntentId.GENERATE_PROPOSAL)).toContain('proposal.generate');
    expect(requiredCapabilities(IntentId.SEARCH_KNOWLEDGE)).toContain('knowledge.search');
    expect(requiredCapabilities(IntentId.ADMIN_ACTION)).toContain('admin.action');
  });

  it('returns empty for intents with no capability mapping', () => {
    expect(requiredCapabilities(IntentId.UNKNOWN)).toEqual([]);
    expect(requiredCapabilities(IntentId.SYSTEM)).toEqual([]);
  });
});
