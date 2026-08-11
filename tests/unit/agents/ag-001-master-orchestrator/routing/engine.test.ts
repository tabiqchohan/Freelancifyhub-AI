import { describe, expect, it } from 'vitest';

import { RoutingEngine } from '../../../../../src/agents/ag-001-master-orchestrator/routing/engine.js';
import { RoutingRegistry } from '../../../../../src/agents/ag-001-master-orchestrator/routing/registry/index.js';
import { parseRoutingConfig } from '../../../../../src/agents/ag-001-master-orchestrator/routing/config/index.js';
import { RoutingValidationError } from '../../../../../src/agents/ag-001-master-orchestrator/routing/errors/index.js';
import {
  ConfidenceLevel,
  EscalationReason,
  ExecutionMode,
  RoutingStatus,
  RoutingStrategy,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import {
  IntentId,
  UserRole,
} from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { AgentStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import {
  makeIntentDefinition,
  makeIntentResult,
  makeAgentRequest,
  makeContextSnapshot,
  makeRoutableAgent,
} from './fixtures.js';

function routeFor(input: Parameters<RoutingEngine['route']>[0], engine?: RoutingEngine) {
  const routingEngine = engine ?? new RoutingEngine();
  return routingEngine.route(input);
}

function baseInput(overrides: Partial<Parameters<RoutingEngine['route']>[0]> = {}) {
  return {
    requestId: 'req-1',
    traceId: 'trace-1',
    request: makeAgentRequest(),
    intent: makeIntentResult(
      makeIntentDefinition({ supportedAgents: ['AG-101', 'AG-102', 'AG-103', 'AG-104', 'AG-105'] }),
    ),
    context: makeContextSnapshot(),
    role: UserRole.Freelancer,
    ...overrides,
  };
}

describe('RoutingEngine - direct intent match', () => {
  it('routes CREATE_PROJECT to AG-101 with high confidence', () => {
    const decision = routeFor(baseInput());

    expect(decision.status).toBe(RoutingStatus.Success);
    expect(decision.selectedAgent?.agent.agentId).toBe('AG-101');
    expect(decision.confidenceLevel).toBe(ConfidenceLevel.High);
    expect(decision.confidence).toBeGreaterThanOrEqual(0.8);
    expect(decision.intentId).toBe(IntentId.CREATE_PROJECT);
  });

  it('routes a single supported intent to the Direct strategy', () => {
    const definition = makeIntentDefinition({
      id: IntentId.SEARCH_KNOWLEDGE,
      supportedAgents: ['AG-003'],
    });
    const decision = routeFor(
      baseInput({
        intent: makeIntentResult(definition),
        request: makeAgentRequest({ agentId: 'AG-003' }),
      }),
    );

    expect(decision.status).toBe(RoutingStatus.Success);
    expect(decision.selectedAgent?.agent.agentId).toBe('AG-003');
    expect(decision.strategy).toBe(RoutingStrategy.Direct);
  });
});

describe('RoutingEngine - capability match', () => {
  it('selects an agent matched only by capability when supported agents are unavailable', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent(
        {
          agentId: 'AG-101',
          capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
        },
        { available: false, reason: 'down' },
      ),
      makeRoutableAgent({
        agentId: 'AG-900',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
    ]);

    const engine = new RoutingEngine({ registry });
    const decision = routeFor(baseInput(), engine);

    expect(decision.status).toBe(RoutingStatus.Fallback);
    expect(decision.selectedAgent?.agent.agentId).toBe('AG-900');
    expect(decision.fallbacks).toHaveLength(1);
    expect(decision.fallbacks[0]?.originalAgentId).toBe('AG-101');
  });

  it('marks candidates matched only by capability with CapabilityMatch strategy', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent({
        agentId: 'AG-101',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
      makeRoutableAgent({
        agentId: 'AG-900',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
    ]);

    const engine = new RoutingEngine({ registry });
    const decision = routeFor(baseInput(), engine);

    const capabilityCandidate = decision.candidates.find((c) => c.agent.agentId === 'AG-900');
    expect(capabilityCandidate?.strategy).toBe(RoutingStrategy.CapabilityMatch);
  });
});

describe('RoutingEngine - multiple candidates and ranking', () => {
  it('returns multiple ranked candidates for CREATE_PROJECT', () => {
    const decision = routeFor(baseInput());

    expect(decision.candidates.length).toBeGreaterThan(1);
    expect(decision.candidates[0]?.agent.agentId).toBe('AG-101');

    for (let i = 1; i < decision.candidates.length; i += 1) {
      expect(decision.candidates[i - 1]!.confidence).toBeGreaterThanOrEqual(
        decision.candidates[i]!.confidence,
      );
    }
  });

  it('ranks an intent-supported agent above a capability-only agent', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent({
        agentId: 'AG-101',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
      makeRoutableAgent({
        agentId: 'AG-900',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
    ]);

    const engine = new RoutingEngine({ registry });
    const decision = routeFor(baseInput(), engine);

    expect(decision.candidates[0]?.agent.agentId).toBe('AG-101');
  });
});

describe('RoutingEngine - role compatibility and permission mismatch', () => {
  it('routes with a compatible role', () => {
    const decision = routeFor(baseInput({ role: UserRole.Freelancer }));

    expect(decision.status).toBe(RoutingStatus.Success);
    expect(decision.selectedAgent?.agent.agentId).toBe('AG-101');
  });

  it('escalates when the role is not allowed by the intent', () => {
    const definition = makeIntentDefinition({
      id: IntentId.ADMIN_ACTION,
      allowedRoles: [UserRole.Admin],
      supportedAgents: ['AG-501'],
    });

    const decision = routeFor(
      baseInput({
        intent: makeIntentResult(definition),
        role: UserRole.Freelancer,
      }),
    );

    expect(decision.status).toBe(RoutingStatus.Escalated);
    expect(decision.escalation?.reason).toBe(EscalationReason.PermissionDenied);
    expect(decision.strategy).toBe(RoutingStrategy.Escalation);
  });
});

describe('RoutingEngine - disabled and unavailable agents', () => {
  it('falls back when the preferred agent is unavailable', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent(
        {
          agentId: 'AG-101',
          capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
        },
        { available: false, reason: 'maintenance' },
      ),
      makeRoutableAgent({
        agentId: 'AG-102',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
    ]);

    const config = parseRoutingConfig({
      ROUTING_WEIGHT_INTENT: '0.33',
      ROUTING_WEIGHT_AVAILABILITY: '0',
    });
    const engine = new RoutingEngine({ registry, config });
    const decision = routeFor(baseInput(), engine);

    expect(decision.status).toBe(RoutingStatus.Fallback);
    expect(decision.selectedAgent?.agent.agentId).toBe('AG-102');
    expect(decision.fallbacks[0]?.reason).toContain('unavailable');
  });

  it('escalates when the preferred agent is unavailable with no fallback', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent(
        {
          agentId: 'AG-101',
          capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
        },
        { available: false, reason: 'down' },
      ),
    ]);

    const engine = new RoutingEngine({ registry });
    const decision = routeFor(baseInput(), engine);

    expect(decision.status).toBe(RoutingStatus.Escalated);
    expect(decision.escalation?.reason).toBe(EscalationReason.AgentUnavailable);
  });

  it('treats a disabled agent (Draft/Retired status) as unavailable', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent({
        agentId: 'AG-202',
        status: AgentStatus.Retired,
        capabilities: [{ id: 'profile.optimize', name: 'optimize', enabled: true }],
      }),
    ]);

    const engine = new RoutingEngine({ registry });
    const definition = makeIntentDefinition({
      id: IntentId.OPTIMIZE_PROFILE,
      supportedAgents: ['AG-202'],
    });

    const decision = routeFor(
      baseInput({
        intent: makeIntentResult(definition),
        request: makeAgentRequest({ agentId: 'AG-202' }),
      }),
      engine,
    );

    expect(decision.status).toBe(RoutingStatus.Escalated);
    expect(decision.escalation?.reason).toBe(EscalationReason.AgentUnavailable);
  });
});

describe('RoutingEngine - no candidate and low confidence', () => {
  it('escalates with NO_MATCH when no agent matches the intent', () => {
    const registry = new RoutingRegistry([]);
    const engine = new RoutingEngine({ registry });

    const decision = routeFor(baseInput(), engine);

    expect(decision.status).toBe(RoutingStatus.Escalated);
    expect(decision.escalation?.reason).toBe(EscalationReason.NoMatch);
    expect(decision.selectedAgent).toBeUndefined();
  });

  it('escalates with LOW_CONFIDENCE below the configured threshold', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent({
        agentId: 'AG-900',
        status: AgentStatus.Draft,
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
    ]);

    const config = parseRoutingConfig({
      ROUTING_CONFIDENCE_HIGH: '0.99',
      ROUTING_CONFIDENCE_LOW: '0.98',
      ROUTING_WEIGHT_INTENT: '0',
      ROUTING_WEIGHT_CAPABILITY: '0',
      ROUTING_WEIGHT_ROLE: '0',
      ROUTING_WEIGHT_STATUS: '1',
      ROUTING_WEIGHT_PRIORITY: '0',
      ROUTING_WEIGHT_COST: '0',
      ROUTING_WEIGHT_AVAILABILITY: '0',
      ROUTING_WEIGHT_CONSTRAINT: '0',
    });

    const engine = new RoutingEngine({ registry, config });

    const definition = makeIntentDefinition({
      supportedAgents: ['AG-101', 'AG-102', 'AG-103', 'AG-104', 'AG-105'],
    });
    const decision = routeFor(baseInput({ intent: makeIntentResult(definition) }), engine);

    expect(decision.status).toBe(RoutingStatus.Escalated);
    expect(decision.escalation?.reason).toBe(EscalationReason.LowConfidence);
    expect(decision.confidenceLevel).toBe(ConfidenceLevel.Low);
  });
});

describe('RoutingEngine - constraints', () => {
  it('excludes excluded agents', () => {
    const decision = routeFor(baseInput({ constraints: { excludedAgents: ['AG-101'] } }));

    expect(decision.candidates.some((c) => c.agent.agentId === 'AG-101')).toBe(false);
    expect(decision.selectedAgent?.agent.agentId).toBe('AG-102');
  });

  it('caps the candidate list to maxCandidates', () => {
    const decision = routeFor(baseInput({ constraints: { maxCandidates: 2 } }));

    expect(decision.candidates.length).toBe(2);
    expect(decision.metadata.candidateCount).toBe(2);
  });

  it('honours a required capability constraint', () => {
    const decision = routeFor(baseInput({ constraints: { requiredCapability: 'project.create' } }));

    for (const candidate of decision.candidates) {
      expect(
        candidate.agent.capabilities.some((cap) => cap.id === 'project.create' && cap.enabled),
      ).toBe(true);
    }
  });

  it('applies configured max candidates when no constraint is given', () => {
    const config = parseRoutingConfig({ ROUTING_MAX_CANDIDATES: '2' });
    const engine = new RoutingEngine({ config });

    const decision = routeFor(baseInput(), engine);

    expect(decision.candidates.length).toBe(2);
  });
});

describe('RoutingEngine - determinism', () => {
  it('produces identical decisions for identical inputs', () => {
    const engine = new RoutingEngine();
    const input = baseInput();

    const first = engine.route(input);
    const second = engine.route(input);

    expect(first.selectedAgent?.agent.agentId).toBe(second.selectedAgent?.agent.agentId);
    expect(first.candidates.map((c) => c.agent.agentId)).toEqual(
      second.candidates.map((c) => c.agent.agentId),
    );
    expect(first.candidates.map((c) => c.confidence)).toEqual(
      second.candidates.map((c) => c.confidence),
    );
    expect(first.status).toBe(second.status);
    expect(first.strategy).toBe(second.strategy);
    expect(first.escalation).toEqual(second.escalation);
  });
});

describe('RoutingEngine - multi-agent mode', () => {
  it('describes a single execution mode by default', () => {
    const decision = routeFor(baseInput());

    expect(decision.executionMode).toBe(ExecutionMode.Single);
  });

  it('describes a parallel mode when multi-agent routing is enabled', () => {
    const registry = new RoutingRegistry([
      makeRoutableAgent({
        agentId: 'AG-101',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
      makeRoutableAgent({
        agentId: 'AG-102',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
    ]);

    const config = parseRoutingConfig({ ROUTING_MULTI_AGENT_ENABLED: 'true' });
    const engine = new RoutingEngine({ config, registry });

    const decision = routeFor(baseInput(), engine);

    expect(decision.executionMode).toBe(ExecutionMode.Parallel);
  });

  it('describes a hybrid mode for many candidates when multi-agent is enabled', () => {
    const config = parseRoutingConfig({ ROUTING_MULTI_AGENT_ENABLED: 'true' });
    const engine = new RoutingEngine({ config });

    const definition = makeIntentDefinition({
      id: IntentId.ADMIN_ACTION,
      allowedRoles: [UserRole.Admin, UserRole.Freelancer],
      supportedAgents: ['AG-501', 'AG-502', 'AG-503', 'AG-504', 'AG-505'],
    });

    const decision = routeFor(
      baseInput({
        intent: makeIntentResult(definition),
        role: UserRole.Freelancer,
      }),
      engine,
    );

    expect(decision.executionMode).toBe(ExecutionMode.Hybrid);
  });
});

describe('RoutingEngine - validation', () => {
  it('rejects a missing request', () => {
    const input = baseInput();
    expect(() => routeFor({ ...input, request: undefined as never })).toThrow(
      RoutingValidationError,
    );
  });

  it('rejects a missing intent', () => {
    const input = baseInput();
    expect(() => routeFor({ ...input, intent: undefined as never })).toThrow(
      RoutingValidationError,
    );
  });

  it('rejects an invalid intent id', () => {
    const input = baseInput();
    const invalidIntent = makeIntentResult(
      makeIntentDefinition({ id: 'bogus.intent' as IntentId }),
    );

    expect(() => routeFor({ ...input, intent: invalidIntent })).toThrow(RoutingValidationError);
  });

  it('rejects a missing context snapshot', () => {
    const input = baseInput();
    expect(() => routeFor({ ...input, context: undefined as never })).toThrow(
      RoutingValidationError,
    );
  });

  it('rejects an invalid user role', () => {
    const input = baseInput();
    expect(() => routeFor({ ...input, role: 'Mystery' as UserRole })).toThrow(
      RoutingValidationError,
    );
  });

  it('rejects duplicate excluded agent ids', () => {
    const input = baseInput({ constraints: { excludedAgents: ['AG-101', 'AG-101'] } });
    expect(() => routeFor(input)).toThrow(RoutingValidationError);
  });

  it('rejects a maxCandidates below 1', () => {
    const input = baseInput({ constraints: { maxCandidates: 0 } });
    expect(() => routeFor(input)).toThrow(RoutingValidationError);
  });
});
