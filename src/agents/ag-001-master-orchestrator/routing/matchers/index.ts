import { AgentStatus, type AgentId } from '../../types/index.js';
import type { AgentConfiguration } from '../../interfaces/execution-context.js';
import type { RoutableAgent } from '../interfaces/index.js';
import type { RoutingConstraints } from '../types/index.js';
import { requiredCapabilities } from '../registry/index.js';

/** Whether the agent declares (enabled) a given capability id. */
export function hasCapability(agent: AgentConfiguration, capabilityId: string): boolean {
  return agent.capabilities.some((cap) => cap.id === capabilityId && cap.enabled);
}

/** Whether the agent serves the intent through a declared capability. */
export function matchesIntentCapability(
  agent: AgentConfiguration,
  intentCapabilities: readonly string[],
): boolean {
  return intentCapabilities.some((id) => hasCapability(agent, id));
}

/** Whether the agent is in the intent's explicit supported-agent list. */
export function isSupportedAgent(
  agent: AgentConfiguration,
  supportedAgents: readonly AgentId[],
): boolean {
  return supportedAgents.includes(agent.agentId);
}

/** Status-based eligibility: production/maintenance/testing/in-development. */
const ROUTABLE_STATUSES: readonly AgentStatus[] = [
  AgentStatus.Production,
  AgentStatus.Maintenance,
  AgentStatus.Testing,
  AgentStatus.InDevelopment,
];

/** Whether the agent status is routable by default. */
export function isRoutableStatus(agent: AgentConfiguration): boolean {
  return ROUTABLE_STATUSES.includes(agent.status);
}

/** Collects constraint violations for an agent (prompt §13). */
export function constraintViolations(
  agent: RoutableAgent,
  constraints: RoutingConstraints | undefined,
): readonly string[] {
  if (constraints === undefined) {
    return [];
  }

  const violations: string[] = [];

  if (constraints.allowedRoles !== undefined && constraints.allowedRoles.length > 0) {
    // Request-level role restriction; agents do not declare roles in Sprint 4,
    // so this is enforced by the engine against the caller role (§13).
  }

  if (constraints.requiredPermissions !== undefined && constraints.requiredPermissions.length > 0) {
    const missing = constraints.requiredPermissions.filter(
      (permission) => !(agent.configuration.permissions ?? []).includes(permission),
    );
    if (missing.length > 0) {
      violations.push(`missing required permissions: ${missing.join(', ')}`);
    }
  }

  if (
    constraints.maxRoutingCost !== undefined &&
    (agent.configuration.cost ?? 1) > constraints.maxRoutingCost
  ) {
    violations.push(
      `routing cost ${(agent.configuration.cost ?? 1).toFixed(3)} exceeds max ${constraints.maxRoutingCost.toFixed(3)}`,
    );
  }

  if (
    constraints.requiredCapability !== undefined &&
    !hasCapability(agent.configuration, constraints.requiredCapability)
  ) {
    violations.push(`missing required capability: ${constraints.requiredCapability}`);
  }

  if (
    constraints.excludedAgents !== undefined &&
    constraints.excludedAgents.includes(agent.configuration.agentId)
  ) {
    violations.push(`agent excluded by id: ${agent.configuration.agentId}`);
  }

  if (
    constraints.allowedStatuses !== undefined &&
    constraints.allowedStatuses.length > 0 &&
    !constraints.allowedStatuses.includes(agent.configuration.status)
  ) {
    violations.push(`status not allowed: ${agent.configuration.status}`);
  }

  return violations;
}

/** Whether the agent satisfies all supplied constraints. */
export function satisfiesConstraints(
  agent: RoutableAgent,
  constraints: RoutingConstraints | undefined,
): boolean {
  return constraintViolations(agent, constraints).length === 0;
}

export { requiredCapabilities };
