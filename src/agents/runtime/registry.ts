import type {
  AgentCapability,
  AgentConfiguration,
} from '../ag-001-master-orchestrator/interfaces/index.js';
import type { AgentId } from '../ag-001-master-orchestrator/types/index.js';
import { AgentStatus } from '../ag-001-master-orchestrator/types/index.js';
import { AgentRegistryError, RUNTIME_AGENT_ERROR_CODES } from './errors.js';
import type { RuntimeAgent } from './types.js';

export type { AgentCapability, AgentConfiguration };
export type { AgentId };

/** Options for constructing an {@link AgentRegistry}. */
export interface AgentRegistryOptions {
  readonly agents?: readonly RuntimeAgent[];
}

/**
 * The single, authoritative registry of production runtime agents (Phase 2).
 *
 * This is the registry the {@link ProductionAgentExecutor} resolves against.
 * Uniqueness of agent identity is enforced at registration time, matching the
 * route registry and the agent catalog (no duplicate ids anywhere).
 */
export class AgentRegistry {
  private readonly agents = new Map<AgentId, RuntimeAgent>();

  constructor(options: AgentRegistryOptions = {}) {
    if (options.agents !== undefined) {
      this.registerAll(options.agents);
    }
  }

  /** Registers an agent; rejects duplicate ids (fail-closed). */
  register(agent: RuntimeAgent): void {
    const agentId = agent.configuration.agentId;
    if (this.agents.has(agentId)) {
      throw new AgentRegistryError(
        RUNTIME_AGENT_ERROR_CODES.DUPLICATE_AGENT_ID,
        `An agent is already registered with id ${agentId}`,
        { agentId },
      );
    }
    this.agents.set(agentId, agent);
  }

  /** Registers many agents atomically; a duplicate aborts the batch. */
  registerAll(agents: readonly RuntimeAgent[]): void {
    for (const agent of agents) {
      this.register(agent);
    }
  }

  /** Removes an agent; returns true when it was registered. */
  unregister(agentId: AgentId): boolean {
    return this.agents.delete(agentId);
  }

  get(agentId: AgentId): RuntimeAgent | undefined {
    return this.agents.get(agentId);
  }

  has(agentId: AgentId): boolean {
    return this.agents.has(agentId);
  }

  /** Whether the agent is registered and currently executable. */
  isAvailable(agentId: AgentId): boolean {
    const agent = this.agents.get(agentId);
    if (agent === undefined) {
      return false;
    }
    return agent.availability.available && agent.configuration.status !== AgentStatus.Retired;
  }

  configurationOf(agentId: AgentId): AgentConfiguration | undefined {
    return this.agents.get(agentId)?.configuration;
  }

  capabilitiesOf(agentId: AgentId): readonly AgentCapability[] | undefined {
    return this.agents.get(agentId)?.configuration.capabilities;
  }

  list(): readonly RuntimeAgent[] {
    return [...this.agents.values()];
  }

  listAvailable(): readonly RuntimeAgent[] {
    return this.list().filter((agent) => this.isAvailable(agent.configuration.agentId));
  }

  get size(): number {
    return this.agents.size;
  }
}
