import {
  IntentCategory,
  IntentId,
  IntentPriority,
  IntentStatus,
  UserRole,
  type IntentDefinition,
  type IntentResult,
} from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import {
  AgentCategory,
  AgentStatus,
  DependencyType,
} from '../../../../../src/agents/ag-001-master-orchestrator/types/index.js';
import type { AgentConfiguration } from '../../../../../src/agents/ag-001-master-orchestrator/interfaces/execution-context.js';
import { ContextBuilder } from '../../../../../src/agents/ag-001-master-orchestrator/context/index.js';
import {
  ContextPriority,
  ContextSectionType,
  ContextSourceType,
} from '../../../../../src/agents/ag-001-master-orchestrator/context/index.js';
import type { ContextSnapshot } from '../../../../../src/agents/ag-001-master-orchestrator/context/index.js';
import type { AgentRequest } from '../../../../../src/agents/ag-001-master-orchestrator/interfaces/agent-request.js';
import {
  ConfidenceLevel,
  ExecutionMode,
  RoutingStatus,
  RoutingStrategy,
  type RouteCandidate,
  type RouteDecision,
  type RoutingMetadata,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';

/** Builds a minimal valid intent definition (defaults to CREATE_PROJECT). */
export function makeIntentDefinition(overrides: Partial<IntentDefinition> = {}): IntentDefinition {
  return {
    id: IntentId.CREATE_PROJECT,
    name: 'Create Project',
    description: 'Freelancer creates and publishes a new project.',
    category: IntentCategory.Projects,
    priority: IntentPriority.High,
    allowedRoles: [UserRole.Freelancer],
    confidenceThreshold: 0.55,
    supportedAgents: ['AG-101', 'AG-102', 'AG-103', 'AG-104', 'AG-105'],
    status: IntentStatus.Active,
    ...overrides,
  };
}

/** Builds a valid IntentResult around a given definition. */
export function makeIntentResult(
  definition: IntentDefinition = makeIntentDefinition(),
  confidence = 0.9,
): IntentResult {
  const candidate = {
    intent: definition,
    confidence,
    matchedKeywords: ['create', 'project'],
    matchedRules: ['rule.project.create'],
  };

  return {
    primary: candidate,
    secondary: [],
    candidates: [candidate],
    confidence,
    matchedKeywords: ['create', 'project'],
    matchedRules: ['rule.project.create'],
    fallback: false,
    metadata: {
      classifier: 'rule-based',
      version: '1.0.0',
      detectedAt: '2026-01-01T00:00:00.000Z',
      inputLength: 20,
      elapsedMs: 1,
      thresholds: { high: 0.8, low: 0.55 },
    },
  };
}

/** Builds an AgentConfiguration fixture. */
export function makeAgentConfiguration(
  overrides: Partial<AgentConfiguration> = {},
): AgentConfiguration {
  return {
    agentId: 'AG-101',
    name: 'Test Agent',
    version: '1.0.0',
    category: AgentCategory.Client,
    status: AgentStatus.InDevelopment,
    capabilities: [{ id: 'project.create', name: 'Create project', enabled: true }],
    dependencies: [{ type: DependencyType.Agent, id: 'AG-001', required: true }],
    limits: { maxTokens: 6000, maxAttempts: 3 },
    ...overrides,
  };
}

/** Builds a valid AgentRequest fixture (Sprint 1 contract). */
export function makeAgentRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    agentId: 'AG-101',
    type: 'route',
    payload: {},
    context: {
      traceId: 'trace-1',
      requestId: 'req-1',
      receivedAt: '2026-01-01T00:00:00.000Z',
      origin: 'test',
    },
    ...overrides,
  };
}

/** Builds a valid ContextSnapshot fixture (Sprint 3 contract). */
export function makeContextSnapshot(): ContextSnapshot {
  const builder = new ContextBuilder();
  const result = builder.build({
    requestId: 'req-1',
    traceId: 'trace-1',
    items: [
      {
        id: 'user-1',
        source: { type: ContextSourceType.USER, id: 'user-1' },
        section: ContextSectionType.USER,
        content: 'Freelancer looking to create a project',
        priority: ContextPriority.HIGH,
      },
    ],
  });

  return result.snapshot;
}

/** Builds a RouteCandidate fixture (Sprint 4 contract). */
export function makeRouteCandidate(
  agent: AgentConfiguration = makeAgentConfiguration(),
  confidence = 0.9,
): RouteCandidate {
  return {
    agent,
    score: {
      total: confidence,
      breakdown: {
        intentMatch: 1,
        capabilityMatch: 1,
        roleCompatibility: 1,
        status: 0.8,
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
    reasons: [{ code: 'INTENT_SUPPORT', message: 'supported' }],
  };
}

/** Builds a RouteDecision fixture (Sprint 4 contract). */
export function makeRouteDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  const candidates = [
    makeRouteCandidate(makeAgentConfiguration({ agentId: 'AG-101' }), 0.97),
    makeRouteCandidate(makeAgentConfiguration({ agentId: 'AG-102' }), 0.94),
    makeRouteCandidate(makeAgentConfiguration({ agentId: 'AG-103' }), 0.91),
  ];

  const metadata: RoutingMetadata = {
    version: '1.0.0',
    routedAt: '2026-01-01T00:00:00.000Z',
    requestId: 'req-1',
    traceId: 'trace-1',
    intentId: IntentId.CREATE_PROJECT,
    strategy: RoutingStrategy.Direct,
    executionMode: ExecutionMode.Single,
    candidateCount: candidates.length,
    fallbackCount: 0,
    escalated: false,
  };

  return {
    requestId: 'req-1',
    traceId: 'trace-1',
    intentId: IntentId.CREATE_PROJECT,
    status: RoutingStatus.Success,
    strategy: RoutingStrategy.Direct,
    executionMode: ExecutionMode.Single,
    confidence: 0.97,
    confidenceLevel: ConfidenceLevel.High,
    confidenceThreshold: 0.55,
    selectedAgent: {
      agent: candidates[0]!.agent,
      score: candidates[0]!.score,
      confidence: candidates[0]!.confidence,
      strategy: RoutingStrategy.Direct,
      reasons: candidates[0]!.reasons,
    },
    candidates,
    fallbacks: [],
    escalation: undefined,
    reasons: [{ code: 'INTENT_SUPPORT', message: 'supported' }],
    metadata,
    ...overrides,
  };
}
