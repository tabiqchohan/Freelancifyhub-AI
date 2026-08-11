import { AgentCategory, AgentStatus, DependencyType, type AgentId } from '../../types/index.js';
import type { AgentConfiguration } from '../../interfaces/execution-context.js';
import type { AgentCapability } from '../../interfaces/agent-capability.js';
import type { AgentDependency } from '../../interfaces/agent-dependency.js';
import { RoutingRegistryError } from '../errors/index.js';
import { IntentId } from '../../intent/index.js';
import type { AgentRoutingRegistry, RoutableAgent } from '../interfaces/index.js';

const CATALOG_AGENTS: readonly {
  readonly agentId: AgentId;
  readonly name: string;
  readonly category: AgentCategory;
  readonly status: AgentStatus;
  readonly capabilities: readonly string[];
  readonly dependencies: readonly string[];
  readonly maxTokens: number;
  readonly maxAttempts: number;
}[] = [
  {
    agentId: 'AG-001',
    name: 'Master Orchestrator',
    category: AgentCategory.Core,
    status: AgentStatus.InDevelopment,
    capabilities: ['route.intent', 'orchestrate'],
    dependencies: ['AG-002', 'AG-003', 'AG-004'],
    maxTokens: 8000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-002',
    name: 'Memory Manager',
    category: AgentCategory.Core,
    status: AgentStatus.InDevelopment,
    capabilities: ['memory.save', 'memory.load', 'memory.search'],
    dependencies: [],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-003',
    name: 'Knowledge Manager',
    category: AgentCategory.Core,
    status: AgentStatus.InDevelopment,
    capabilities: ['knowledge.search', 'knowledge.answer'],
    dependencies: ['AG-002'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-004',
    name: 'Tool Manager',
    category: AgentCategory.Core,
    status: AgentStatus.InDevelopment,
    capabilities: ['tool.execute', 'tool.lookup'],
    dependencies: [],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-101',
    name: 'Project Description Agent',
    category: AgentCategory.Client,
    status: AgentStatus.InDevelopment,
    capabilities: ['project.create', 'project.edit', 'project.delete', 'project.view'],
    dependencies: ['AG-001'],
    maxTokens: 6000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-102',
    name: 'Budget Estimator',
    category: AgentCategory.Client,
    status: AgentStatus.InDevelopment,
    capabilities: ['project.budget.estimate'],
    dependencies: ['AG-101'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-103',
    name: 'Timeline Estimator',
    category: AgentCategory.Client,
    status: AgentStatus.InDevelopment,
    capabilities: ['project.timeline.estimate'],
    dependencies: ['AG-101'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-104',
    name: 'Skills Recommendation',
    category: AgentCategory.Client,
    status: AgentStatus.InDevelopment,
    capabilities: ['project.skills.recommend'],
    dependencies: ['AG-101'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-105',
    name: 'Project Success Score',
    category: AgentCategory.Client,
    status: AgentStatus.InDevelopment,
    capabilities: ['project.success.score'],
    dependencies: ['AG-101'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-201',
    name: 'Proposal Writer',
    category: AgentCategory.Freelancer,
    status: AgentStatus.InDevelopment,
    capabilities: ['proposal.submit', 'proposal.generate', 'proposal.draft'],
    dependencies: ['AG-001'],
    maxTokens: 6000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-202',
    name: 'Profile Optimizer',
    category: AgentCategory.Freelancer,
    status: AgentStatus.Draft,
    capabilities: ['profile.optimize'],
    dependencies: ['AG-001'],
    maxTokens: 6000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-203',
    name: 'Portfolio Builder',
    category: AgentCategory.Freelancer,
    status: AgentStatus.Draft,
    capabilities: ['portfolio.build'],
    dependencies: ['AG-001'],
    maxTokens: 6000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-204',
    name: 'Resume Builder',
    category: AgentCategory.Freelancer,
    status: AgentStatus.Draft,
    capabilities: ['resume.build'],
    dependencies: ['AG-001'],
    maxTokens: 6000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-205',
    name: 'Cover Letter Generator',
    category: AgentCategory.Freelancer,
    status: AgentStatus.Draft,
    capabilities: ['cover-letter.generate'],
    dependencies: ['AG-001'],
    maxTokens: 6000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-206',
    name: 'Project Recommendation',
    category: AgentCategory.Freelancer,
    status: AgentStatus.InDevelopment,
    capabilities: ['project.match', 'project.search', 'project.recommend'],
    dependencies: ['AG-001'],
    maxTokens: 6000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-207',
    name: 'Career Advisor',
    category: AgentCategory.Freelancer,
    status: AgentStatus.Draft,
    capabilities: ['career.advice'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-301',
    name: 'Contract Generator',
    category: AgentCategory.Marketplace,
    status: AgentStatus.Draft,
    capabilities: ['contract.generate'],
    dependencies: ['AG-001'],
    maxTokens: 6000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-302',
    name: 'Milestone Planner',
    category: AgentCategory.Marketplace,
    status: AgentStatus.Draft,
    capabilities: ['milestone.plan'],
    dependencies: ['AG-301'],
    maxTokens: 6000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-303',
    name: 'Review Generator',
    category: AgentCategory.Marketplace,
    status: AgentStatus.Draft,
    capabilities: ['review.generate'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-304',
    name: 'Scam Detection',
    category: AgentCategory.Marketplace,
    status: AgentStatus.InDevelopment,
    capabilities: ['security.scam', 'scam.report'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-305',
    name: 'Dispute Assistant',
    category: AgentCategory.Marketplace,
    status: AgentStatus.Draft,
    capabilities: ['dispute.open'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-306',
    name: 'Messaging Assistant',
    category: AgentCategory.Marketplace,
    status: AgentStatus.InDevelopment,
    capabilities: ['message.send', 'platform.help'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-401',
    name: 'Research Agent',
    category: AgentCategory.Marketing,
    status: AgentStatus.Draft,
    capabilities: ['research.analyze'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-402',
    name: 'Social Media Manager',
    category: AgentCategory.Marketing,
    status: AgentStatus.Draft,
    capabilities: ['marketing.social'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-403',
    name: 'Blog Writer',
    category: AgentCategory.Marketing,
    status: AgentStatus.Draft,
    capabilities: ['content.write'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-404',
    name: 'SEO Specialist',
    category: AgentCategory.Marketing,
    status: AgentStatus.Draft,
    capabilities: ['marketing.seo'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-405',
    name: 'Email Marketing',
    category: AgentCategory.Marketing,
    status: AgentStatus.Draft,
    capabilities: ['marketing.email'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-501',
    name: 'Analytics Agent',
    category: AgentCategory.Admin,
    status: AgentStatus.InDevelopment,
    capabilities: ['analytics.query', 'admin.action'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-502',
    name: 'Fraud Monitoring',
    category: AgentCategory.Admin,
    status: AgentStatus.InDevelopment,
    capabilities: ['security.fraud', 'fraud.monitor', 'scam.report'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-503',
    name: 'Platform Health',
    category: AgentCategory.Admin,
    status: AgentStatus.Draft,
    capabilities: ['platform.health'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-504',
    name: 'AI Operations',
    category: AgentCategory.Admin,
    status: AgentStatus.Draft,
    capabilities: ['ai.ops'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
  {
    agentId: 'AG-505',
    name: 'Executive Insights',
    category: AgentCategory.Admin,
    status: AgentStatus.Draft,
    capabilities: ['analytics.executive'],
    dependencies: ['AG-001'],
    maxTokens: 4000,
    maxAttempts: 3,
  },
];

function toAgentConfiguration(entry: (typeof CATALOG_AGENTS)[number]): AgentConfiguration {
  const capabilities: readonly AgentCapability[] = entry.capabilities.map((id) => ({
    id,
    name: id,
    enabled: true,
  }));

  const dependencies: readonly AgentDependency[] = entry.dependencies.map((id) => ({
    type: DependencyType.Agent,
    id,
    required: true,
  }));

  return {
    agentId: entry.agentId,
    name: entry.name,
    version: '1.0.0',
    category: entry.category,
    status: entry.status,
    capabilities,
    dependencies,
    limits: { maxTokens: entry.maxTokens, maxAttempts: entry.maxAttempts },
  };
}

/**
 * Default routing catalog adapter. Reflects the documented Agent Catalog
 * (agent-catalog-v1.md §8) into the minimal {@link RoutableAgent} routing view.
 * The routing layer treats this as an adapter, not a second source of truth.
 */
export function buildDefaultCatalog(): readonly RoutableAgent[] {
  return CATALOG_AGENTS.map((entry) => ({
    configuration: toAgentConfiguration(entry),
    availability: { available: true },
  }));
}

/** Maps an intent id to the capability ids that must be present. */
const INTENT_CAPABILITIES: Readonly<Record<IntentId, readonly string[]>> = {
  [IntentId.UNKNOWN]: [],
  [IntentId.CREATE_PROJECT]: ['project.create'],
  [IntentId.UPDATE_PROJECT]: ['project.edit'],
  [IntentId.DELETE_PROJECT]: ['project.delete'],
  [IntentId.VIEW_PROJECT]: ['project.view'],
  [IntentId.SEARCH_PROJECTS]: ['project.search'],
  [IntentId.SUBMIT_PROPOSAL]: ['proposal.submit'],
  [IntentId.GENERATE_PROPOSAL]: ['proposal.generate'],
  [IntentId.OPTIMIZE_PROFILE]: ['profile.optimize'],
  [IntentId.BUILD_PORTFOLIO]: ['portfolio.build'],
  [IntentId.BUILD_RESUME]: ['resume.build'],
  [IntentId.GENERATE_COVER_LETTER]: ['cover-letter.generate'],
  [IntentId.MATCH_PROJECT]: ['project.match'],
  [IntentId.CAREER_ADVICE]: ['career.advice'],
  [IntentId.GENERATE_CONTRACT]: ['contract.generate'],
  [IntentId.PLAN_MILESTONES]: ['milestone.plan'],
  [IntentId.GENERATE_REVIEW]: ['review.generate'],
  [IntentId.REPORT_SCAM]: ['scam.report'],
  [IntentId.OPEN_DISPUTE]: ['dispute.open'],
  [IntentId.SEND_MESSAGE]: ['message.send'],
  [IntentId.SEARCH_KNOWLEDGE]: ['knowledge.search'],
  [IntentId.PLATFORM_HELP]: ['platform.help'],
  [IntentId.ADMIN_ACTION]: ['admin.action'],
  [IntentId.SYSTEM]: [],
};

/** Capability ids required to serve a given intent (prompt §5). */
export function requiredCapabilities(intentId: IntentId): readonly string[] {
  return INTENT_CAPABILITIES[intentId] ?? [];
}

/**
 * Deterministic in-memory routing registry (prompt §3). It is a routing-layer
 * adapter over {@link AgentConfiguration}; it does not replace the Agent
 * Catalog. Registration is idempotent-safe: duplicate ids are rejected.
 */
export class RoutingRegistry implements AgentRoutingRegistry {
  private readonly agents = new Map<AgentId, RoutableAgent>();

  constructor(initial: readonly RoutableAgent[] = buildDefaultCatalog()) {
    for (const agent of initial) {
      this.register(agent);
    }
  }

  register(agent: RoutableAgent): void {
    const id = agent.configuration.agentId;

    if (this.agents.has(id)) {
      throw new RoutingRegistryError(`Duplicate agent id in routing registry: ${id}`);
    }

    if (!this.validateAgent(agent)) {
      throw new RoutingRegistryError(`Invalid agent entry: ${id}`);
    }

    this.agents.set(id, agent);
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

  findCandidates(intentId: IntentId): readonly RoutableAgent[] {
    const required = requiredCapabilities(intentId);

    return this.list().filter((agent) => {
      if (required.length === 0) {
        return false;
      }

      const capabilities = new Set(agent.configuration.capabilities.map((cap) => cap.id));

      return required.some((id) => capabilities.has(id));
    });
  }

  validateAgent(agent: RoutableAgent): boolean {
    const config = agent.configuration;

    if (typeof config.agentId !== 'string' || config.agentId.trim().length === 0) {
      return false;
    }

    if (typeof config.name !== 'string' || config.name.trim().length === 0) {
      return false;
    }

    if (!Object.values(AgentStatus).includes(config.status)) {
      return false;
    }

    return true;
  }
}
