import type { AgentConfiguration } from '../../interfaces/execution-context.js';
import type { RouteCandidate } from '../../routing/types/index.js';
import type {
  ExecutionReference,
  ExecutionReferenceType,
  ExecutionPolicy,
  ExecutionRetryPolicy,
} from '../types/index.js';
import type { PlanningConfig } from '../config/index.js';

/** Builds a declarative reference (prompt §15). */
export function reference(
  id: string,
  type: ExecutionReferenceType,
  optional = false,
): ExecutionReference {
  return { id, type, optional };
}

/** Deterministic step id in the form `step-N`. */
export function stepId(index: number): string {
  return `step-${index + 1}`;
}

/** Deterministic condition id in the form `cond-N`. */
export function conditionId(index: number): string {
  return `cond-${index + 1}`;
}

/** Deterministic branch id in the form `branch-N`. */
export function branchId(index: number): string {
  return `branch-${index + 1}`;
}

/** Default retry policy derived from the planning config (prompt §13). */
export function defaultRetry(config: PlanningConfig): ExecutionRetryPolicy {
  return {
    maxRetries: config.PLANNING_DEFAULT_RETRY_COUNT,
    retryable: true,
    backoffMs: 1_000,
  };
}

/** Default execution policy derived from the planning config (prompt §13). */
export function defaultPolicy(config: PlanningConfig): ExecutionPolicy {
  return {
    timeoutMs: config.PLANNING_DEFAULT_TIMEOUT_MS,
    retry: defaultRetry(config),
    failureBehavior: config.PLANNING_DEFAULT_FAILURE_POLICY,
    continueOnFailure: false,
    stopOnFailure: true,
    fallbackAllowed: true,
    maxSteps: config.PLANNING_MAX_STEPS,
    maxTotalExecutionTimeMs: config.PLANNING_MAX_STEPS * config.PLANNING_DEFAULT_TIMEOUT_MS,
  };
}

/** Enabled capability ids declared by an agent. */
export function requiredCapabilities(agent: AgentConfiguration): readonly string[] {
  return agent.capabilities
    .filter((capability) => capability.enabled)
    .map((capability) => capability.id);
}

/** Input references for the step at the given zero-based index (prompt §15). */
export function buildInputReferences(index: number): readonly ExecutionReference[] {
  const references: ExecutionReference[] = [
    reference('request.input', 'request'),
    reference('context.user', 'context', true),
    reference('context.project', 'context', true),
    reference('route.metadata', 'route', true),
  ];

  if (index > 0) {
    references.push(reference(`${stepId(index - 1)}.output`, 'step', true));
  }

  return references;
}

/** Output reference for a step (prompt §15). */
export function outputReference(stepIdValue: string): ExecutionReference {
  return reference(`${stepIdValue}.output`, 'step');
}

/** Whether the agent appears among the route candidates. */
export function agentInCandidates(agentId: string, candidates: readonly RouteCandidate[]): boolean {
  return candidates.some((candidate) => candidate.agent.agentId === agentId);
}
