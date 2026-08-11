import { describe, expect, it } from 'vitest';

import { DeterministicRouteScorer } from '../../../../../src/agents/ag-001-master-orchestrator/routing/scorers/index.js';
import { parseRoutingConfig } from '../../../../../src/agents/ag-001-master-orchestrator/routing/config/index.js';
import { weightsFromConfig } from '../../../../../src/agents/ag-001-master-orchestrator/routing/utils/index.js';
import {
  IntentPriority,
  IntentId,
  UserRole,
} from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { AgentStatus } from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import { makeIntentDefinition, makeIntentResult, makeRoutableAgent } from './fixtures.js';

const config = parseRoutingConfig({});
const weights = weightsFromConfig(config);

function scorer() {
  return new DeterministicRouteScorer(weights);
}

describe('DeterministicRouteScorer', () => {
  it('scores a fully matching candidate at the top of the range', () => {
    const score = scorer().score({
      agent: makeRoutableAgent({
        agentId: 'AG-101',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
      intent: makeIntentResult(),
      role: UserRole.Freelancer,
    });

    expect(score.total).toBeCloseTo(0.97, 5);
    expect(score.breakdown.intentMatch).toBe(1);
    expect(score.breakdown.capabilityMatch).toBe(1);
    expect(score.breakdown.roleCompatibility).toBe(1);
    expect(score.breakdown.availability).toBe(1);
    expect(score.breakdown.constraintCompatibility).toBe(1);
  });

  it('reduces the score when the agent lacks the required capability', () => {
    const withCapability = scorer().score({
      agent: makeRoutableAgent({
        agentId: 'AG-101',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
      intent: makeIntentResult(),
      role: UserRole.Freelancer,
    });

    const withoutCapability = scorer().score({
      agent: makeRoutableAgent({
        agentId: 'AG-102',
        capabilities: [{ id: 'other', name: 'other', enabled: true }],
      }),
      intent: makeIntentResult(),
      role: UserRole.Freelancer,
    });

    expect(withoutCapability.total).toBeLessThan(withCapability.total);
    expect(withoutCapability.breakdown.capabilityMatch).toBe(0);
  });

  it('reduces the score for a disabled (Retired) status', () => {
    const production = scorer().score({
      agent: makeRoutableAgent({
        agentId: 'AG-101',
        status: AgentStatus.Production,
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
      intent: makeIntentResult(),
      role: UserRole.Freelancer,
    });

    const retired = scorer().score({
      agent: makeRoutableAgent({
        agentId: 'AG-101',
        status: AgentStatus.Retired,
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
      intent: makeIntentResult(),
      role: UserRole.Freelancer,
    });

    expect(retired.breakdown.status).toBe(0);
    expect(retired.total).toBeLessThan(production.total);
  });

  it('reduces the score for an unavailable agent', () => {
    const available = scorer().score({
      agent: makeRoutableAgent({
        agentId: 'AG-101',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
      intent: makeIntentResult(),
      role: UserRole.Freelancer,
    });

    const unavailable = scorer().score({
      agent: makeRoutableAgent(
        {
          agentId: 'AG-101',
          capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
        },
        { available: false, reason: 'down' },
      ),
      intent: makeIntentResult(),
      role: UserRole.Freelancer,
    });

    expect(unavailable.breakdown.availability).toBe(0);
    expect(unavailable.total).toBeLessThan(available.total);
  });

  it('scores role compatibility from the intent allowed roles', () => {
    const definition = makeIntentDefinition({
      id: IntentId.ADMIN_ACTION,
      allowedRoles: [UserRole.Admin],
    });

    const allowed = scorer().score({
      agent: makeRoutableAgent({ agentId: 'AG-501' }),
      intent: makeIntentResult(definition),
      role: UserRole.Admin,
    });

    const denied = scorer().score({
      agent: makeRoutableAgent({ agentId: 'AG-501' }),
      intent: makeIntentResult(definition),
      role: UserRole.Freelancer,
    });

    expect(allowed.breakdown.roleCompatibility).toBe(1);
    expect(denied.breakdown.roleCompatibility).toBe(0);
  });

  it('uses the intent priority in the score', () => {
    const critical = scorer().score({
      agent: makeRoutableAgent({ agentId: 'AG-101' }),
      intent: makeIntentResult(makeIntentDefinition({ priority: IntentPriority.Critical })),
      role: UserRole.Freelancer,
    });

    const low = scorer().score({
      agent: makeRoutableAgent({ agentId: 'AG-101' }),
      intent: makeIntentResult(makeIntentDefinition({ priority: IntentPriority.Low })),
      role: UserRole.Freelancer,
    });

    expect(critical.breakdown.priority).toBeGreaterThan(low.breakdown.priority);
  });

  it('is fully deterministic', () => {
    const input = {
      agent: makeRoutableAgent({
        agentId: 'AG-101',
        capabilities: [{ id: 'project.create', name: 'create', enabled: true }],
      }),
      intent: makeIntentResult(),
      role: UserRole.Freelancer,
    };

    const a = scorer().score(input);
    const b = scorer().score(input);

    expect(a).toEqual(b);
  });

  it('reports the configured weights in the result', () => {
    const score = scorer().score({
      agent: makeRoutableAgent(),
      intent: makeIntentResult(),
      role: UserRole.Freelancer,
    });

    expect(score.weights).toEqual(weights);
  });
});
