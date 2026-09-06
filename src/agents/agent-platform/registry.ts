/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. Agent Definition Registry.
 *
 * Owns the authoritative set of registered {@link AgentDefinition}s and their
 * operational lifecycle state. Duplicate ids are rejected; every definition is
 * re-validated on registration; agent dependencies are checked for availability
 * and cycles; the registry exposes deterministic discovery (capability, status,
 * execution mode, readiness) plus the catalog snapshot used by health.
 */

import type {
  AgentConfiguration,
  RoutableAgent,
} from '../ag-001-master-orchestrator/routing/interfaces/index.js';
import { DependencyType } from '../ag-001-master-orchestrator/types/index.js';
import type { AgentId } from '../ag-001-master-orchestrator/types/index.js';
import type { AgentPlatformEventLog } from './events.js';
import {
  AgentAlreadyRegisteredError,
  AgentDefinitionInvalidError,
  AgentDependencyCycleError,
  AgentDependencyUnavailableError,
  AgentNotFoundError,
} from './errors.js';
import { AgentLifecycleState } from './lifecycle.js';
import { AgentLifecycleController } from './lifecycle.js';
import type { AgentPlatformMetrics } from './metrics.js';
import type { AgentPlatformStatusSnapshot } from './types.js';
import type { AgentExecutionMode } from './types.js';
import type { AgentDefinition, AgentRegistration } from './types.js';
import { parseAgentDefinition } from './schemas.js';

/** Options to build the agent definition registry. */
export interface AgentDefinitionRegistryOptions {
  readonly lifecycle?: AgentLifecycleController;
  readonly metrics?: AgentPlatformMetrics;
  readonly eventLog?: AgentPlatformEventLog;
  /** Predicate to verify an allowed tool exists in the tool manager. */
  readonly toolExists?: (toolName: string) => boolean;
  readonly now?: () => string;
}

/** Options for discovery methods. */
export interface DiscoveryOptions {
  /** Limit results to agents currently routable/ready. */
  readonly onlyReady?: boolean;
  /** Include agents whose capability entries are enabled. */
  readonly enabled?: boolean;
}

/** Canonical, durable registry for agent definitions + lifecycle. */
export class AgentDefinitionRegistry {
  readonly name = 'agent-definition-registry';

  private readonly registrations = new Map<AgentId, AgentRegistration>();
  private readonly lifecycle: AgentLifecycleController;
  private readonly metrics?: AgentPlatformMetrics;
  private readonly toolExists?: (toolName: string) => boolean;
  private readonly now: () => string;

  constructor(options: AgentDefinitionRegistryOptions = {}) {
    this.lifecycle = options.lifecycle ?? createDefaultLifecycle(options.eventLog, options.metrics);
    this.metrics = options.metrics;
    this.toolExists = options.toolExists;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get lifecycleController(): AgentLifecycleController {
    return this.lifecycle;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Validates and registers the agent definition, then optionally activates it.
   * Throws on duplicates, invalid definitions, missing required dependencies,
   * or dependency cycles.
   */
  registerAgent(
    definitionInput: AgentDefinition,
    options: { readonly activate?: boolean } = {},
  ): AgentRegistration {
    const definition = parseAgentDefinition(definitionInput);
    if (this.registrations.has(definition.agentId)) {
      throw new AgentAlreadyRegisteredError(
        `Agent ${definition.agentId} is already registered with the platform`,
        { agentId: definition.agentId },
      );
    }
    this.assertToolsExist(definition);
    this.assertDependencies(definition);

    this.lifecycle.register(definition.agentId);
    const registration: AgentRegistration = {
      definition,
      registeredAt: this.now(),
    };
    this.registrations.set(definition.agentId, registration);
    if (options.activate === true) {
      this.activate(definition.agentId);
    }
    this.reconcileMetrics();
    return registration;
  }

  /** Registered → Initializing → Ready (derives the documented path). */
  activate(agentId: AgentId): void {
    this.requireRegistered(agentId);
    this.lifecycle.activate(agentId);
    this.reconcileMetrics();
  }

  /** Pause the agent (READY/RUNNING → PAUSED). */
  pauseAgent(agentId: AgentId): void {
    this.requireRegistered(agentId);
    this.lifecycle.pause(agentId);
    this.reconcileMetrics();
  }

  /** Resume the agent (PAUSED → READY). */
  resumeAgent(agentId: AgentId): void {
    this.requireRegistered(agentId);
    this.lifecycle.resume(agentId);
    this.reconcileMetrics();
  }

  /** Begin graceful drain (READY/RUNNING → DRAINING → DISABLED). */
  drainAgent(agentId: AgentId): void {
    this.requireRegistered(agentId);
    this.lifecycle.drain(agentId);
    this.reconcileMetrics();
  }

  /** Mark the agent failed / recover it back to initialization. */
  failAgent(agentId: AgentId): void {
    this.requireRegistered(agentId);
    this.lifecycle.fail(agentId);
    this.reconcileMetrics();
  }

  recoverAgent(agentId: AgentId): void {
    this.requireRegistered(agentId);
    this.lifecycle.recover(agentId);
    this.reconcileMetrics();
  }

  /** Terminate the agent (final). */
  terminateAgent(agentId: AgentId): void {
    this.requireRegistered(agentId);
    this.lifecycle.terminate(agentId);
    this.reconcileMetrics();
  }

  /** Removes the agent; refuses while executions are in flight. */
  unregisterAgent(agentId: AgentId): boolean {
    this.requireRegistered(agentId);
    this.lifecycle.unregister(agentId);
    const removed = this.registrations.delete(agentId);
    this.reconcileMetrics();
    return removed;
  }

  // -------------------------------------------------------------------------
  // Lookup & discovery
  // -------------------------------------------------------------------------

  getAgent(agentId: AgentId): AgentDefinition | undefined {
    return this.registrations.get(agentId)?.definition;
  }

  getRegistration(agentId: AgentId): AgentRegistration | undefined {
    return this.registrations.get(agentId);
  }

  hasAgent(agentId: AgentId): boolean {
    return this.registrations.has(agentId);
  }

  listAgents(): readonly AgentDefinition[] {
    return Array.from(this.registrations.values()).map((r) => r.definition);
  }

  findAgentsByCapability(capabilityId: string, options: DiscoveryOptions = {}): AgentDefinition[] {
    return this.listAgents().filter((definition) => {
      if (options.onlyReady === true && !this.isAgentRoutable(definition.agentId)) {
        return false;
      }
      return definition.capabilities.some(
        (c) => c.id === capabilityId && (options.enabled === false ? true : c.enabled),
      );
    });
  }

  findAgentsByStatus(status: string): AgentDefinition[] {
    return this.listAgents().filter((d) => d.status === status);
  }

  findAgentsByExecutionMode(
    mode: AgentExecutionMode,
    options: DiscoveryOptions = {},
  ): AgentDefinition[] {
    return this.listAgents().filter((definition) => {
      if (options.onlyReady === true && !this.isAgentRoutable(definition.agentId)) {
        return false;
      }
      return definition.executionModes.includes(mode);
    });
  }

  /** Agents whose lifecycle permits execution right now. */
  findReadyAgents(): AgentDefinition[] {
    return this.listAgents().filter((d) => this.lifecycle.isRoutable(d.agentId));
  }

  /** Direct agent dependencies declared by a definition. */
  agentDependencies(agentId: AgentId): readonly AgentId[] {
    const definition = this.registrations.get(agentId)?.definition;
    if (definition === undefined) {
      return [];
    }
    return definition.dependencies.filter((d) => d.type === DependencyType.Agent).map((d) => d.id);
  }

  /** Routing view of an agent (configuration + availability). */
  toRoutableAgent(agentId: AgentId): RoutableAgent | undefined {
    const registration = this.registrations.get(agentId);
    if (registration === undefined) {
      return undefined;
    }
    const routable = this.lifecycle.isRoutable(agentId);
    return {
      configuration: toAgentConfiguration(registration.definition),
      availability: {
        available: routable,
        reason: routable
          ? undefined
          : `lifecycle:${String(this.lifecycle.stateOf(agentId) ?? AgentLifecycleState.Registered)}`,
      },
    };
  }

  /** Current operational state of a registered agent (undefined if absent). */
  lifecycleStateOf(agentId: AgentId): AgentLifecycleState | undefined {
    return this.registrations.has(agentId) ? this.lifecycle.stateOf(agentId) : undefined;
  }

  isAgentRoutable(agentId: AgentId): boolean {
    return this.registrations.has(agentId) && this.lifecycle.isRoutable(agentId);
  }

  // -------------------------------------------------------------------------
  // Status & health
  // -------------------------------------------------------------------------

  snapshot(): AgentPlatformStatusSnapshot {
    const summary = this.lifecycle.summary();
    const states = summary.states;
    const activeExecutions = summary.activeExecutions;
    const ready = states[AgentLifecycleState.Ready] + states[AgentLifecycleState.Running];
    return Object.freeze({
      registered: this.registrations.size,
      ready,
      running: states[AgentLifecycleState.Running],
      paused: states[AgentLifecycleState.Paused],
      draining: states[AgentLifecycleState.Draining],
      disabled: states[AgentLifecycleState.Disabled],
      failed: states[AgentLifecycleState.Failed],
      terminated: states[AgentLifecycleState.Terminated],
      activeExecutions,
      healthy: ready > 0,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireRegistered(agentId: AgentId): void {
    if (!this.registrations.has(agentId)) {
      throw new AgentNotFoundError(`Agent ${agentId} is not registered`, { agentId });
    }
  }

  /** Middleware-style; only inspects values locally. Separated for readability. */
  private assertToolsExist(definition: AgentDefinition): void {
    const toolExists = this.toolExists;
    if (toolExists === undefined) {
      return;
    }
    const missing = definition.allowedTools.filter((tool) => !toolExists(tool));
    if (missing.length > 0) {
      throw new AgentDefinitionInvalidError(
        `Agent ${definition.agentId} declares unavailable tools: ${missing.join(', ')}`,
        { agentId: definition.agentId, missingTools: missing },
      );
    }
  }

  private assertDependencies(definition: AgentDefinition): void {
    const candidateEdges: readonly AgentId[] = definition.dependencies
      .filter((d) => d.type === DependencyType.Agent)
      .map((d) => d.id);
    for (const dep of candidateEdges) {
      if (definition.dependencies.length > 0) {
        const required = definition.dependencies.some(
          (d) => d.type === DependencyType.Agent && d.id === dep && d.required,
        );
        if (required && !this.hasAgent(dep)) {
          throw new AgentDependencyUnavailableError(
            `Agent ${definition.agentId} requires dependency ${dep} which is not registered`,
            { agentId: definition.agentId, dependencyId: dep },
          );
        }
      }
    }
    const cycle = this.findDependencyCycle(definition.agentId, candidateEdges);
    if (cycle !== undefined) {
      throw new AgentDependencyCycleError(
        `Dependency cycle detected involving ${definition.agentId}: ${cycle.join(' -> ')}`,
        { agentId: definition.agentId, cycle },
      );
    }
  }

  /** DFS that incorporates the candidate edges into the existing graph. */
  private findDependencyCycle(
    start: AgentId,
    candidateEdges: readonly AgentId[],
  ): string[] | undefined {
    const edgesOf = (node: AgentId): readonly AgentId[] =>
      node === start ? candidateEdges : this.agentDependencies(node);
    const states = new Map<AgentId, 0 | 1 | 2>();
    const path: AgentId[] = [];
    const visit = (node: AgentId): string[] | undefined => {
      const mark = states.get(node) ?? 0;
      if (mark === 1) {
        const cycleStart = path.indexOf(node);
        return path.slice(cycleStart).concat(node);
      }
      if (mark === 2) {
        return undefined;
      }
      states.set(node, 1);
      path.push(node);
      for (const dep of edgesOf(node)) {
        if (dep === start) {
          return path.concat(start);
        }
        const found = visit(dep);
        if (found !== undefined) {
          return found;
        }
      }
      path.pop();
      states.set(node, 2);
      return undefined;
    };
    return visit(start);
  }

  private reconcileMetrics(): void {
    if (this.metrics === undefined) {
      return;
    }
    const summary = this.lifecycle.summary();
    this.metrics.setAgentCounts({
      registered: this.registrations.size,
      ready:
        summary.states[AgentLifecycleState.Ready] + summary.states[AgentLifecycleState.Running],
      running: summary.states[AgentLifecycleState.Running],
      paused: summary.states[AgentLifecycleState.Paused],
      draining: summary.states[AgentLifecycleState.Draining],
      disabled: summary.states[AgentLifecycleState.Disabled],
      failed: summary.states[AgentLifecycleState.Failed],
      terminated: summary.states[AgentLifecycleState.Terminated],
      activeExecutions: summary.activeExecutions,
    });
  }
}

/** Builds the default lifecycle controller used when none is injected. */
export function createDefaultLifecycle(
  eventLog?: AgentPlatformEventLog,
  metrics?: AgentPlatformMetrics,
): AgentLifecycleController {
  return new AgentLifecycleController({ eventLog, metrics });
}

/** Maps the platform definition to the AG-001 routing configuration shape. */
export function toAgentConfiguration(definition: AgentDefinition): AgentConfiguration {
  return {
    agentId: definition.agentId,
    name: definition.name,
    version: definition.version,
    category: definition.category,
    status: definition.status,
    capabilities: definition.capabilities,
    dependencies: definition.dependencies,
    permissions: definition.permissions.length > 0 ? definition.permissions : undefined,
    limits: {
      maxTokens: definition.limits.maxTokenBudget ?? definition.limits.maxContextBytes,
      maxAttempts: 1,
      timeoutMs: definition.limits.maxExecutionTimeMs,
    },
  };
}
