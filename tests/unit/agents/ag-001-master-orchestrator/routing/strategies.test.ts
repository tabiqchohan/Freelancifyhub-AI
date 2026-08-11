import { describe, expect, it } from 'vitest';

import {
  sortCandidates,
  toConfidenceLevel,
  resolveStrategy,
  resolveExecutionMode,
  applyCandidateLimit,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/strategies/index.js';
import { resolveFallbacks } from '../../../../../src/agents/ag-001-master-orchestrator/routing/fallback/index.js';
import { resolveEscalation } from '../../../../../src/agents/ag-001-master-orchestrator/routing/escalations/index.js';
import {
  ConfidenceLevel,
  EscalationReason,
  ExecutionMode,
  RoutingStatus,
  RoutingStrategy,
  type RouteCandidate,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import {
  IntentId,
  IntentPriority,
  UserRole,
} from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { makeIntentDefinition, makeIntentResult, makeRoutableAgent } from './fixtures.js';

function candidate(agentId: string, confidence: number): RouteCandidate {
  return {
    agent: makeRoutableAgent({ agentId }).configuration,
    score: {
      total: confidence,
      breakdown: {
        intentMatch: 1,
        capabilityMatch: 1,
        roleCompatibility: 1,
        status: 1,
        priority: 0.8,
        cost: 1,
        availability: 1,
        constraintCompatibility: 1,
      },
      weights: {
        intentMatch: 0.3,
        capabilityMatch: 0.25,
        roleCompatibility: 0.2,
        status: 0.1,
        priority: 0.05,
        cost: 0.03,
        availability: 0.03,
        constraintCompatibility: 0.04,
      },
    },
    confidence,
    strategy: RoutingStrategy.Direct,
    reasons: [],
  };
}

describe('sortCandidates', () => {
  it('sorts by confidence descending', () => {
    const sorted = sortCandidates([candidate('a', 0.5), candidate('b', 0.9)]);

    expect(sorted.map((c) => c.agent.agentId)).toEqual(['b', 'a']);
  });

  it('breaks ties deterministically by agent id', () => {
    const sorted = sortCandidates([candidate('b', 0.5), candidate('a', 0.5)]);

    expect(sorted.map((c) => c.agent.agentId)).toEqual(['a', 'b']);
  });
});

describe('toConfidenceLevel', () => {
  it('maps confidence to High/Medium/Low using spec thresholds', () => {
    expect(toConfidenceLevel(0.9, 0.55, 0.8)).toBe(ConfidenceLevel.High);
    expect(toConfidenceLevel(0.7, 0.55, 0.8)).toBe(ConfidenceLevel.Medium);
    expect(toConfidenceLevel(0.4, 0.55, 0.8)).toBe(ConfidenceLevel.Low);
    expect(toConfidenceLevel(0.8, 0.55, 0.8)).toBe(ConfidenceLevel.High);
    expect(toConfidenceLevel(0.55, 0.55, 0.8)).toBe(ConfidenceLevel.Medium);
  });
});

describe('resolveStrategy', () => {
  it('returns Escalation for an escalated status', () => {
    expect(
      resolveStrategy({
        intent: makeIntentResult(),
        candidates: [],
        status: RoutingStatus.Escalated,
        confidence: 0.3,
        lowThreshold: 0.55,
      }),
    ).toBe(RoutingStrategy.Escalation);
  });

  it('returns Direct for a single high-confidence candidate', () => {
    expect(
      resolveStrategy({
        intent: makeIntentResult(),
        candidates: [candidate('a', 0.9)],
        status: RoutingStatus.Success,
        confidence: 0.9,
        lowThreshold: 0.55,
      }),
    ).toBe(RoutingStrategy.Direct);
  });

  it('returns Fallback for a fallback status', () => {
    expect(
      resolveStrategy({
        intent: makeIntentResult(),
        candidates: [candidate('a', 0.9), candidate('b', 0.8)],
        status: RoutingStatus.Fallback,
        confidence: 0.9,
        lowThreshold: 0.55,
      }),
    ).toBe(RoutingStrategy.Fallback);
  });

  it('returns Priority for multiple candidates on a priority intent', () => {
    const definition = makeIntentDefinition({ priority: IntentPriority.High });
    expect(
      resolveStrategy({
        intent: makeIntentResult(definition),
        candidates: [candidate('a', 0.9), candidate('b', 0.8)],
        status: RoutingStatus.Success,
        confidence: 0.9,
        lowThreshold: 0.55,
      }),
    ).toBe(RoutingStrategy.Priority);
  });
});

describe('resolveExecutionMode', () => {
  it('returns Single by default', () => {
    expect(resolveExecutionMode([candidate('a', 0.9)], false)).toBe(ExecutionMode.Single);
    expect(resolveExecutionMode([], false)).toBe(ExecutionMode.Single);
  });

  it('returns Parallel for 2-3 candidates when multi-agent is enabled', () => {
    expect(resolveExecutionMode([candidate('a', 0.9), candidate('b', 0.8)], true)).toBe(
      ExecutionMode.Parallel,
    );
  });

  it('returns Hybrid for more than 3 candidates', () => {
    const many = [
      candidate('a', 0.9),
      candidate('b', 0.8),
      candidate('c', 0.7),
      candidate('d', 0.6),
    ];
    expect(resolveExecutionMode(many, true)).toBe(ExecutionMode.Hybrid);
  });
});

describe('applyCandidateLimit', () => {
  it('caps to the constraint when present', () => {
    const list = [candidate('a', 0.9), candidate('b', 0.8), candidate('c', 0.7)];

    expect(applyCandidateLimit(list, { maxCandidates: 2 }, 5)).toHaveLength(2);
  });

  it('caps to the configured max when no constraint is given', () => {
    const list = [candidate('a', 0.9), candidate('b', 0.8), candidate('c', 0.7)];

    expect(applyCandidateLimit(list, undefined, 2)).toHaveLength(2);
  });

  it('never exceeds the configured max', () => {
    const list = [candidate('a', 0.9), candidate('b', 0.8), candidate('c', 0.7)];

    expect(applyCandidateLimit(list, { maxCandidates: 10 }, 2)).toHaveLength(2);
  });
});

describe('resolveFallbacks', () => {
  it('selects the next available candidate when the primary is unavailable', () => {
    const result = resolveFallbacks({
      candidates: [candidate('a', 0.9), candidate('b', 0.8)],
      selectedAgent: {
        agent: candidate('a', 0.9).agent,
        score: candidate('a', 0.9).score,
        confidence: 0.9,
        strategy: RoutingStrategy.Direct,
        reasons: [],
      },
      enabled: true,
      excludedAgentIds: new Set(),
      availableAgentIds: new Set(['b']),
    });

    expect(result.status).toBe(RoutingStatus.Fallback);
    expect(result.selectedAgent?.agent.agentId).toBe('b');
    expect(result.fallbacks[0]?.originalAgentId).toBe('a');
    expect(result.fallbacks[0]?.fallbackAgentId).toBe('b');
    expect(result.fallbacks[0]?.reason).toContain('unavailable');
  });

  it('does nothing when the primary is available', () => {
    const result = resolveFallbacks({
      candidates: [candidate('a', 0.9), candidate('b', 0.8)],
      selectedAgent: {
        agent: candidate('a', 0.9).agent,
        score: candidate('a', 0.9).score,
        confidence: 0.9,
        strategy: RoutingStrategy.Direct,
        reasons: [],
      },
      enabled: true,
      excludedAgentIds: new Set(),
      availableAgentIds: new Set(['a', 'b']),
    });

    expect(result.status).toBe(RoutingStatus.Success);
    expect(result.fallbacks).toHaveLength(0);
  });

  it('signals fallbackRequired when no fallback exists', () => {
    const result = resolveFallbacks({
      candidates: [candidate('a', 0.9)],
      selectedAgent: {
        agent: candidate('a', 0.9).agent,
        score: candidate('a', 0.9).score,
        confidence: 0.9,
        strategy: RoutingStrategy.Direct,
        reasons: [],
      },
      enabled: true,
      excludedAgentIds: new Set(),
      availableAgentIds: new Set(),
    });

    expect(result.fallbackRequired).toBe(true);
    expect(result.status).toBe(RoutingStatus.Success);
  });

  it('is disabled when fallback is off', () => {
    const result = resolveFallbacks({
      candidates: [candidate('a', 0.9), candidate('b', 0.8)],
      selectedAgent: {
        agent: candidate('a', 0.9).agent,
        score: candidate('a', 0.9).score,
        confidence: 0.9,
        strategy: RoutingStrategy.Direct,
        reasons: [],
      },
      enabled: false,
      excludedAgentIds: new Set(),
      availableAgentIds: new Set(['b']),
    });

    expect(result.status).toBe(RoutingStatus.Success);
    expect(result.fallbacks).toHaveLength(0);
  });
});

describe('resolveEscalation', () => {
  const base = {
    intent: makeIntentResult(makeIntentDefinition({ id: IntentId.CREATE_PROJECT })),
    role: UserRole.Freelancer,
    confidence: 0.9,
    confidenceLevel: ConfidenceLevel.High,
    lowThreshold: 0.55,
    enabled: true,
  };

  it('escalates with NO_MATCH when there are no candidates', () => {
    const result = resolveEscalation({ ...base, candidates: [] });

    expect(result.status).toBe(RoutingStatus.Escalated);
    expect(result.escalation?.reason).toBe(EscalationReason.NoMatch);
  });

  it('escalates with PERMISSION_DENIED when the role is not allowed', () => {
    const result = resolveEscalation({
      ...base,
      role: UserRole.Guest,
      candidates: [candidate('a', 0.9)],
    });

    expect(result.status).toBe(RoutingStatus.Escalated);
    expect(result.escalation?.reason).toBe(EscalationReason.PermissionDenied);
  });

  it('escalates with LOW_CONFIDENCE below the threshold', () => {
    const result = resolveEscalation({
      ...base,
      confidence: 0.4,
      confidenceLevel: ConfidenceLevel.Low,
      candidates: [candidate('a', 0.4)],
    });

    expect(result.status).toBe(RoutingStatus.Escalated);
    expect(result.escalation?.reason).toBe(EscalationReason.LowConfidence);
  });

  it('returns Success when a valid route exists', () => {
    const result = resolveEscalation({
      ...base,
      candidates: [candidate('a', 0.9)],
    });

    expect(result.status).toBe(RoutingStatus.Success);
    expect(result.escalation).toBeUndefined();
  });

  it('is disabled when escalation is off', () => {
    const result = resolveEscalation({
      ...base,
      enabled: false,
      candidates: [],
    });

    expect(result.status).toBe(RoutingStatus.Success);
  });
});
