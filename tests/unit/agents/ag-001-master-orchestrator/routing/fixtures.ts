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
import type { RoutableAgent } from '../../../../../src/agents/ag-001-master-orchestrator/routing/interfaces/index.js';

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

/** Builds a RoutableAgent fixture. */
export function makeRoutableAgent(
  overrides: Partial<AgentConfiguration> = {},
  availability: { readonly available: boolean; readonly reason?: string } = { available: true },
): RoutableAgent {
  return {
    configuration: makeAgentConfiguration(overrides),
    availability,
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

/** Completes a minimal context snapshot for quick fixtures. */
export function minimalContext(): ContextSnapshot {
  const builder = new ContextBuilder();
  return builder.build({ requestId: 'req-1', traceId: 'trace-1', items: [] }).snapshot;
}
