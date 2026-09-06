/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. Routing integration.
 *
 * Decorates the AG-001 {@link AgentRoutingRegistry} so that agents owned by the
 * Agent Platform expose their live lifecycle as routing availability:
 *
 *   - agents NOT managed by the platform keep their previous behavior
 *     (backward compatible — no behavior change for catalog-only agents);
 *   - platform-managed agents are available only while lifecycle is routable
 *     (READY/RUNNING), so PAUSED/DRAINING/DISABLED/FAILED agents are never
 *     chosen by the routing engine.
 */

import type {
  AgentRoutingRegistry,
  RoutableAgent,
} from '../ag-001-master-orchestrator/routing/interfaces/index.js';
import type { IntentId } from '../ag-001-master-orchestrator/intent/index.js';
import type { AgentId } from '../ag-001-master-orchestrator/types/index.js';
import type { AgentDefinitionRegistry } from './registry.js';

/** Options for the platform-aware routing decorator. */
export interface PlatformAwareRoutingRegistryOptions {
  readonly inner: AgentRoutingRegistry;
  readonly platform: AgentDefinitionRegistry;
}

/**
 * Live availability view of an agent: platform-managed agents reflect their
 * lifecycle; unmanaged agents are untouched (availability never enlarged).
 */
export class PlatformAwareRoutingRegistry implements AgentRoutingRegistry {
  readonly name = 'platform-aware-routing-registry';

  private readonly inner: AgentRoutingRegistry;
  private readonly platform: AgentDefinitionRegistry;

  constructor(options: PlatformAwareRoutingRegistryOptions) {
    this.inner = options.inner;
    this.platform = options.platform;
  }

  register(agent: RoutableAgent): void {
    this.inner.register(agent);
  }

  unregister(agentId: AgentId): void {
    this.inner.unregister(agentId);
    this.platform.unregisterAgent(agentId);
  }

  get(agentId: AgentId): RoutableAgent | undefined {
    const agent = this.inner.get(agentId);
    if (agent === undefined) {
      return undefined;
    }
    return this.decorate(agent);
  }

  list(): readonly RoutableAgent[] {
    return this.inner.list().map((agent) => this.decorate(agent));
  }

  findCandidates(intentId: IntentId): readonly RoutableAgent[] {
    return this.inner.findCandidates(intentId).map((agent) => this.decorate(agent));
  }

  validateAgent(agent: RoutableAgent): boolean {
    return this.inner.validateAgent(agent);
  }

  /** Apply the platform lifecycle as the availability source of truth. */
  private decorate(agent: RoutableAgent): RoutableAgent {
    if (!this.platform.hasAgent(agent.configuration.agentId)) {
      return agent;
    }
    const routable = this.platform.toRoutableAgent(agent.configuration.agentId);
    if (routable === undefined) {
      // Platform owns it but removed it from the catalog view; treat as unavailable.
      return {
        configuration: agent.configuration,
        availability: { available: false, reason: 'lifecycle:UNREGISTERED' },
      };
    }
    return routable;
  }
}

/** Wraps a routing engine's registry with platform awareness (if not already). */
export function withPlatformAwareness(
  inner: AgentRoutingRegistry,
  platform: AgentDefinitionRegistry,
): AgentRoutingRegistry {
  if (inner instanceof PlatformAwareRoutingRegistry) {
    return inner;
  }
  return new PlatformAwareRoutingRegistry({ inner, platform });
}
