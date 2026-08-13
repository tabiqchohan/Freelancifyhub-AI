import { ExecutionPlanBuilder } from '../../../../../src/agents/ag-001-master-orchestrator/planning/builders/index.js';
import type { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { UserRole } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import type { ExecutionPlan } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import type { FailurePolicy } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import {
  makeAgentRequest,
  makeIntentResult,
  makeContextSnapshot,
  makeRouteDecision,
} from '../planning/fixtures.js';

export function buildSinglePlan(
  overrides: {
    requestId?: string;
    traceId?: string;
    policy?: Partial<{
      failureBehavior: FailurePolicy;
      timeoutMs: number;
      retry: { maxRetries: number; retryable: boolean };
    }>;
  } = {},
): ExecutionPlan {
  const builder = new ExecutionPlanBuilder();
  const plan = builder.build({
    requestId: overrides.requestId ?? 'req-ex-1',
    traceId: overrides.traceId ?? 'trace-ex-1',
    request: makeAgentRequest({ agentId: 'AG-101' }),
    intent: makeIntentResult(),
    context: makeContextSnapshot(),
    route: makeRouteDecision(),
    role: UserRole.Freelancer,
  });

  if (overrides.policy === undefined) {
    return plan;
  }

  return applyPolicy(plan, overrides.policy);
}

export function buildPlanForMode(
  mode: ExecutionMode,
  overrides: {
    requestId?: string;
    traceId?: string;
    policy?: Partial<{
      failureBehavior: FailurePolicy;
      timeoutMs: number;
      retry: { maxRetries: number; retryable: boolean };
    }>;
  } = {},
  routeOverrides: Record<string, unknown> = {},
): ExecutionPlan {
  const builder = new ExecutionPlanBuilder();
  const plan = builder.build({
    requestId: overrides.requestId ?? 'req-ex-1',
    traceId: overrides.traceId ?? 'trace-ex-1',
    request: makeAgentRequest({ agentId: 'AG-101' }),
    intent: makeIntentResult(),
    context: makeContextSnapshot(),
    route: makeRouteDecision({ executionMode: mode, ...routeOverrides }),
    role: UserRole.Freelancer,
  });

  if (overrides.policy === undefined) {
    return plan;
  }

  return applyPolicy(plan, overrides.policy);
}

function applyPolicy(
  plan: ExecutionPlan,
  policy: {
    failureBehavior?: FailurePolicy;
    timeoutMs?: number;
    retry?: { maxRetries: number; retryable: boolean };
  },
): ExecutionPlan {
  const steps = plan.steps.map((step) => ({
    ...step,
    timeoutMs: policy.timeoutMs ?? step.timeoutMs,
    retry: policy.retry !== undefined ? { ...step.retry, ...policy.retry } : step.retry,
    policy: {
      ...step.policy,
      timeoutMs: policy.timeoutMs ?? step.policy.timeoutMs,
      failureBehavior: policy.failureBehavior ?? step.policy.failureBehavior,
      retry:
        policy.retry !== undefined ? { ...step.policy.retry, ...policy.retry } : step.policy.retry,
    },
  }));

  return {
    ...plan,
    steps,
    policy: {
      ...plan.policy,
      failureBehavior: policy.failureBehavior ?? plan.policy.failureBehavior,
      timeoutMs: policy.timeoutMs ?? plan.policy.timeoutMs,
      retry:
        policy.retry !== undefined ? { ...plan.policy.retry, ...policy.retry } : plan.policy.retry,
    },
  };
}

export function baseExecutionRequest(plan: ExecutionPlan, overrides: Record<string, unknown> = {}) {
  return {
    executionId: 'exec-1',
    plan,
    requestId: 'req-ex-1',
    traceId: 'trace-ex-1',
    inputs: {
      'request.input': { action: 'create-project' },
    },
    ...overrides,
  };
}
