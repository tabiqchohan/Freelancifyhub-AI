import { IntentRegistryError } from '../errors.js';
import {
  IntentCategory,
  IntentId,
  IntentPriority,
  IntentStatus,
  UserRole,
  type IntentDefinition,
} from '../types.js';
import { INTENT_KEYWORDS } from '../constants/keywords.js';

/** Builds the official v1 intent registry from the architecture
 * (orchestrator spec §5 supported intents; catalog route targets). */
export function buildDefaultDefinitions(): readonly IntentDefinition[] {
  return [
    {
      id: IntentId.UNKNOWN,
      name: 'Unknown',
      description: 'Request that could not be classified with confidence.',
      category: IntentCategory.System,
      priority: IntentPriority.Low,
      allowedRoles: [UserRole.Client, UserRole.Freelancer, UserRole.Guest],
      confidenceThreshold: 0,
      supportedAgents: [],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.CREATE_PROJECT,
      name: 'Create Project',
      description: 'Freelancer creates and publishes a new project.',
      category: IntentCategory.Projects,
      priority: IntentPriority.High,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-101', 'AG-102', 'AG-103', 'AG-104', 'AG-105'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.UPDATE_PROJECT,
      name: 'Update Project',
      description: 'Freelancer edits an existing project.',
      category: IntentCategory.Projects,
      priority: IntentPriority.Medium,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-101'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.DELETE_PROJECT,
      name: 'Delete Project',
      description: 'Freelancer removes a project.',
      category: IntentCategory.Projects,
      priority: IntentPriority.Medium,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.6,
      supportedAgents: ['AG-101'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.VIEW_PROJECT,
      name: 'View Project',
      description: 'Read-only access to a single project.',
      category: IntentCategory.Projects,
      priority: IntentPriority.Low,
      allowedRoles: [UserRole.Client, UserRole.Freelancer, UserRole.Guest],
      confidenceThreshold: 0.5,
      supportedAgents: ['AG-101'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.SEARCH_PROJECTS,
      name: 'Search Projects',
      description: 'Browse or search the project marketplace.',
      category: IntentCategory.Projects,
      priority: IntentPriority.Medium,
      allowedRoles: [UserRole.Client, UserRole.Freelancer, UserRole.Guest],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-101', 'AG-206'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.SUBMIT_PROPOSAL,
      name: 'Submit Proposal',
      description: 'Freelancer applies to a project with a proposal.',
      category: IntentCategory.Proposals,
      priority: IntentPriority.High,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-201', 'AG-205'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.GENERATE_PROPOSAL,
      name: 'Generate Proposal',
      description: 'Draft or write a proposal for a project.',
      category: IntentCategory.Proposals,
      priority: IntentPriority.High,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-201', 'AG-205'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.OPTIMIZE_PROFILE,
      name: 'Optimize Profile',
      description: 'Improve the freelancer profile for conversion.',
      category: IntentCategory.Profiles,
      priority: IntentPriority.Medium,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-202'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.BUILD_PORTFOLIO,
      name: 'Build Portfolio',
      description: 'Prepare or refresh a portfolio.',
      category: IntentCategory.Profiles,
      priority: IntentPriority.Medium,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-203'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.BUILD_RESUME,
      name: 'Build Resume',
      description: 'Create or update a resume.',
      category: IntentCategory.Profiles,
      priority: IntentPriority.Medium,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-204'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.GENERATE_COVER_LETTER,
      name: 'Generate Cover Letter',
      description: 'Draft a cover letter.',
      category: IntentCategory.Profiles,
      priority: IntentPriority.Medium,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-205'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.MATCH_PROJECT,
      name: 'Match Project',
      description: 'Find the best matching projects for a freelancer.',
      category: IntentCategory.Proposals,
      priority: IntentPriority.Medium,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-206'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.CAREER_ADVICE,
      name: 'Career Advice',
      description: 'Guidance on skills, pricing, or career growth.',
      category: IntentCategory.Profiles,
      priority: IntentPriority.Low,
      allowedRoles: [UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-207'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.GENERATE_CONTRACT,
      name: 'Generate Contract',
      description: 'Create a milestone-based contract.',
      category: IntentCategory.Contracts,
      priority: IntentPriority.High,
      allowedRoles: [UserRole.Client, UserRole.Freelancer],
      confidenceThreshold: 0.6,
      supportedAgents: ['AG-301'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.PLAN_MILESTONES,
      name: 'Plan Milestones',
      description: 'Set project milestones and schedule payment.',
      category: IntentCategory.Contracts,
      priority: IntentPriority.High,
      allowedRoles: [UserRole.Client, UserRole.Freelancer],
      confidenceThreshold: 0.6,
      supportedAgents: ['AG-302'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.GENERATE_REVIEW,
      name: 'Generate Review',
      description: 'Rate a freelancer or client after completion.',
      category: IntentCategory.Reviews,
      priority: IntentPriority.Medium,
      allowedRoles: [UserRole.Client, UserRole.Freelancer],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-303'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.REPORT_SCAM,
      name: 'Report Scam',
      description: 'Flag suspicious or fraudulent activity.',
      category: IntentCategory.Admin,
      priority: IntentPriority.Critical,
      allowedRoles: [UserRole.Client, UserRole.Freelancer, UserRole.Guest],
      confidenceThreshold: 0.6,
      supportedAgents: ['AG-304', 'AG-502'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.OPEN_DISPUTE,
      name: 'Open Dispute',
      description: 'Open a dispute on a project or payment.',
      category: IntentCategory.Admin,
      priority: IntentPriority.Critical,
      allowedRoles: [UserRole.Client, UserRole.Freelancer],
      confidenceThreshold: 0.6,
      supportedAgents: ['AG-305', 'AG-502'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.SEND_MESSAGE,
      name: 'Send Message',
      description: 'Send or reply to a message.',
      category: IntentCategory.Messages,
      priority: IntentPriority.Low,
      allowedRoles: [UserRole.Client, UserRole.Freelancer],
      confidenceThreshold: 0.45,
      supportedAgents: ['AG-306'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.SEARCH_KNOWLEDGE,
      name: 'Search Knowledge',
      description: 'Query the knowledge base for articles.',
      category: IntentCategory.Knowledge,
      priority: IntentPriority.Low,
      allowedRoles: [UserRole.Client, UserRole.Freelancer, UserRole.Guest],
      confidenceThreshold: 0.55,
      supportedAgents: ['AG-003'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.PLATFORM_HELP,
      name: 'Platform Help',
      description: 'General help or support for using the platform.',
      category: IntentCategory.Help,
      priority: IntentPriority.Low,
      allowedRoles: [UserRole.Client, UserRole.Freelancer, UserRole.Guest],
      confidenceThreshold: 0.45,
      supportedAgents: ['AG-306', 'AG-003'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.ADMIN_ACTION,
      name: 'Admin Action',
      description: 'Administrative or moderation action.',
      category: IntentCategory.Admin,
      priority: IntentPriority.High,
      allowedRoles: [UserRole.Admin],
      confidenceThreshold: 0.6,
      supportedAgents: ['AG-501', 'AG-502', 'AG-503', 'AG-504', 'AG-505'],
      status: IntentStatus.Active,
    },
    {
      id: IntentId.SYSTEM,
      name: 'System',
      description: 'Internal system-level request.',
      category: IntentCategory.System,
      priority: IntentPriority.Low,
      allowedRoles: [UserRole.System],
      confidenceThreshold: 0,
      supportedAgents: ['AG-001'],
      status: IntentStatus.Active,
    },
  ];
}

/** The intent registry with duplicate detection and lookup (prompt §1/§8). */
export class IntentRegistry {
  private readonly definitions: Map<IntentId, IntentDefinition>;
  private readonly keywords: Map<IntentId, readonly string[]>;

  constructor(
    definitions: readonly IntentDefinition[] = buildDefaultDefinitions(),
    keywordMap: Readonly<Record<IntentId, readonly string[]>> = INTENT_KEYWORDS,
  ) {
    this.definitions = new Map();
    this.keywords = new Map();

    for (const definition of definitions) {
      if (this.definitions.has(definition.id)) {
        throw new IntentRegistryError(`Duplicate intent id: ${definition.id}`);
      }
      this.definitions.set(definition.id, definition);
      this.keywords.set(definition.id, keywordMap[definition.id] ?? []);
    }

    this.assertUniqueKeywords();
  }

  private assertUniqueKeywords(): void {
    const seen = new Map<string, IntentId>();

    for (const [intentId, keywords] of this.keywords) {
      for (const keyword of keywords) {
        const prior = seen.get(keyword);

        if (prior !== undefined && prior !== intentId) {
          throw new IntentRegistryError(
            `Duplicate keyword "${keyword}" shared by "${prior}" and "${intentId}"`,
          );
        }
        seen.set(keyword, intentId);
      }
    }
  }

  has(id: IntentId): boolean {
    return this.definitions.has(id);
  }

  get(id: IntentId): IntentDefinition | undefined {
    return this.definitions.get(id);
  }

  getAll(): readonly IntentDefinition[] {
    return [...this.definitions.values()];
  }

  getKeywords(id: IntentId): readonly string[] {
    return this.keywords.get(id) ?? [];
  }
}

/** The default registry instance (single source of truth). */
export const intentRegistry = new IntentRegistry();
