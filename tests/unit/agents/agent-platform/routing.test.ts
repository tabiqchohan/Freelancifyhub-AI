import { describe, expect, it } from 'vitest';

import type {
  AgentRoutingRegistry,
  RoutableAgent,
} from '../../../../src/agents/ag-001-master-orchestrator/routing/interfaces/index.js';
import { IntentId } from '../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import {
  AgentCategory,
  AgentStatus,
} from '../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import type { AgentId } from '../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { AgentDefinitionRegistry } from '../../../../src/agents/agent-platform/registry.js';
import { withPlatformAwareness } from '../../../../src/agents/agent-platform/routing.js';
import { makeDefinition } from './fixtures.js';

/** Minimal inner registry for verifying the decorator's behavior. */
class FakeCatalog implements AgentRoutingRegistry {
  readonly name = 'fake-catalog';
  private readonly agents = new Map<AgentId, RoutableAgent>();

  register(agent: RoutableAgent): void {
    this.agents.set(agent.configuration.agentId, agent);
  }

  unregister(agentId: AgentId): void {
    this.agents.delete(agentId);
  }

  get(agentId: AgentId): RoutableAgent | undefined {
    return this.agents.get(agentId);
  }

  list(): readonly RoutableAgent[] {
    return [...this.agents.values()];
  }

  findCandidates(_intentId: IntentId): readonly RoutableAgent[] {
    return [...this.agents.values()];
  }

  validateAgent(): boolean {
    return true;
  }
}

describe('PlatformAwareRoutingRegistry', () => {
  function setup() {
    const inner = new FakeCatalog();
    const platform = new AgentDefinitionRegistry();
    platform.registerAgent(makeDefinition(), { activate: true });
    const wrapper = withPlatformAwareness(inner, platform);
    inner.register({
      configuration: {
        agentId: 'AG-222',
        name: 'Test Agent 222',
        version: '1.0.0',
        category: AgentCategory.Core,
        status: AgentStatus.Production,
        capabilities: [],
        dependencies: [],
      },
      availability: { available: true },
    });
    inner.register({
      configuration: {
        agentId: 'AG-900',
        name: 'Catalog-only Agent',
        version: '1.0.0',
        category: AgentCategory.Core,
        status: AgentStatus.Production,
        capabilities: [],
        dependencies: [],
      },
      availability: { available: true },
    });
    return { inner, platform, wrapper };
  }

  it('overrides availability for platform-managed agents from live lifecycle', () => {
    const { wrapper } = setup();
    const managed = wrapper.get('AG-222');
    expect(managed?.availability.available).toBe(true);

    // Pausing the platform agent makes it unavailable to routing.
    const setup2 = setup();
    setup2.platform.pauseAgent('AG-222');
    const paused = setup2.wrapper.get('AG-222');
    expect(paused?.availability.available).toBe(false);
    expect(paused?.availability.reason).toContain('PAUSED');
    expect(setup2.wrapper.list().some((a) => a.availability.available)).toBe(true);
  });

  it('keeps non-platform agents untouched (backward compatibility)', () => {
    const { wrapper } = setup();
    const catalogOnly = wrapper.get('AG-900');
    expect(catalogOnly?.availability.available).toBe(true);
    expect(catalogOnly?.availability.reason).toBeUndefined();
  });

  it('findCandidates reflects platform lifecycle', () => {
    const { wrapper } = setup();
    const candidates = wrapper.findCandidates(IntentId.UNKNOWN);
    expect(candidates.length).toBe(2);
    const setup2 = setup();
    setup2.platform.failAgent('AG-222');
    const candidates2 = setup2.wrapper.findCandidates(IntentId.UNKNOWN);
    const managed = candidates2.find((a) => a.configuration.agentId === 'AG-222');
    expect(managed?.availability.available).toBe(false);
  });

  it('is idempotent when already wrapped', () => {
    const inner = new FakeCatalog();
    const platform = new AgentDefinitionRegistry();
    const once = withPlatformAwareness(inner, platform);
    expect(withPlatformAwareness(once, platform)).toBe(once);
  });
});
