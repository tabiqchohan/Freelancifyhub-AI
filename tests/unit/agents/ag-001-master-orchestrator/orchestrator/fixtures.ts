import { ContextBuilder } from '../../../../../src/agents/ag-001-master-orchestrator/context/index.js';
import { ExecutionEngine } from '../../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import { parseExecutionConfig } from '../../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import {
  FakeAgentExecutor,
  StaticExecutorRegistry,
} from '../../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import type { ExecutionResult } from '../../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { RuleBasedIntentClassifier } from '../../../../../src/agents/ag-001-master-orchestrator/intent/classifiers/index.js';
import type {
  IntentClassifier,
  IntentDefinition,
  IntentResult,
} from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { ExecutionPlanBuilder } from '../../../../../src/agents/ag-001-master-orchestrator/planning/builders/index.js';
import type { ExecutionPlan } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import { RoutingEngine } from '../../../../../src/agents/ag-001-master-orchestrator/routing/engine.js';
import type { AgentRoutingRegistry } from '../../../../../src/agents/ag-001-master-orchestrator/routing/interfaces/index.js';
import { RoutingRegistry } from '../../../../../src/agents/ag-001-master-orchestrator/routing/registry/index.js';
import type { RouteDecision } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { SharedAggregationService } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/aggregators/index.js';
import type { AggregatedResponse } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/types/index.js';
import type {
  AggregationServiceContract,
  CancellableExecutionEngine,
  ContextBuilderContract,
  ExecutionPlanBuilderContract,
  RoutingEngineContract,
} from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/interfaces/index.js';
import { InMemoryOrchestratorEventEmitter } from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/services/events.js';
import { MasterOrchestratorService } from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/services/master-orchestrator.service.js';
import type { ExecutionMode } from '../../../../../src/agents/ag-001-master-orchestrator/routing/types/index.js';
import { buildPlanForMode } from '../execution/fixtures.js';

export { makeIntentDefinition, makeIntentResult, makeRouteDecision } from '../planning/fixtures.js';
export { makeRoutableAgent } from '../routing/fixtures.js';
export type { IntentClassifier };

/** Stub intent classifier returning a fixed result. */
export function stubIntentClassifier(result: IntentResult): IntentClassifier {
  return {
    name: 'stub-intent-classifier',
    version: '1.0.0',
    classify: () => result,
  };
}

/** Stub intent classifier that throws. */
export function stubIntentClassifierThatThrows(error: unknown): IntentClassifier {
  return {
    name: 'stub-intent-classifier-throws',
    version: '1.0.0',
    classify: () => {
      throw error;
    },
  };
}

/** Stub routing engine returning a fixed decision. */
export function stubRoutingEngine(decision: RouteDecision): RoutingEngineContract {
  return {
    name: 'stub-routing-engine',
    version: '1.0.0',
    route: () => decision,
  };
}

/** Stub routing engine that throws. */
export function stubRoutingEngineThatThrows(error: unknown): RoutingEngineContract {
  return {
    name: 'stub-routing-engine-throws',
    version: '1.0.0',
    route: () => {
      throw error;
    },
  };
}

/** Stub plan builder returning a fixed plan. */
export function stubPlanBuilder(plan: ExecutionPlan): ExecutionPlanBuilderContract {
  return {
    name: 'stub-plan-builder',
    version: '1.0.0',
    build: () => plan,
  };
}

/** Stub plan builder that throws. */
export function stubPlanBuilderThatThrows(error: unknown): ExecutionPlanBuilderContract {
  return {
    name: 'stub-plan-builder-throws',
    version: '1.0.0',
    build: () => {
      throw error;
    },
  };
}

/** Stub aggregation service returning a fixed response. */
export function stubAggregationService(response: AggregatedResponse): AggregationServiceContract {
  return {
    aggregate: () => response,
  };
}

/** Stub aggregation service that throws. */
export function stubAggregationServiceThatThrows(error: unknown): AggregationServiceContract {
  return {
    aggregate: () => {
      throw error;
    },
  };
}

/** Stub cancellation-capable execution engine. */
export function stubExecutionEngine(
  result: ExecutionResult,
  onCancel: (executionId: string, reason: string) => void = () => undefined,
): CancellableExecutionEngine {
  return {
    name: 'stub-execution-engine',
    version: '1.0.0',
    execute: async () => result,
    cancel: (executionId, reason = 'cancelled by caller') => {
      onCancel(executionId, reason);
    },
  };
}

/** Stub execution engine that throws. */
export function stubExecutionEngineThatThrows(error: unknown): CancellableExecutionEngine {
  return {
    name: 'stub-execution-engine-throws',
    version: '1.0.0',
    execute: async () => {
      throw error;
    },
    cancel: () => undefined,
  };
}

/** Overrides a plan's timeout budget for timeout tests. */
export function planWithTimeout(plan: ExecutionPlan, timeoutMs: number): ExecutionPlan {
  return {
    ...plan,
    policy: {
      ...plan.policy,
      timeoutMs,
      maxTotalExecutionTimeMs: timeoutMs,
    },
    steps: plan.steps.map((step) => ({
      ...step,
      timeoutMs,
      policy: {
        ...step.policy,
        timeoutMs,
        maxTotalExecutionTimeMs: timeoutMs,
      },
    })),
  };
}

/** Builds a plan for the given execution mode via the real plan builder. */
export function planForMode(
  mode: 'single' | 'parallel' | 'sequential' | 'conditional' | 'hybrid',
): ExecutionPlan {
  return buildPlanForMode(mode as ExecutionMode);
}

export interface CreateTestServiceOptions {
  readonly intentClassifier?: IntentClassifier;
  readonly contextBuilder?: ContextBuilderContract;
  readonly routingEngine?: RoutingEngineContract;
  readonly planBuilder?: ExecutionPlanBuilderContract;
  readonly executionEngine?: CancellableExecutionEngine;
  readonly aggregationService?: AggregationServiceContract;
  readonly registry?: AgentRoutingRegistry;
  readonly executor?: FakeAgentExecutor;
}

/** Wires a MasterOrchestratorService with real engines (overridable). */
export function createTestService(options: CreateTestServiceOptions = {}): {
  readonly service: MasterOrchestratorService;
  readonly executor: FakeAgentExecutor;
  readonly events: InMemoryOrchestratorEventEmitter;
} {
  const executor = options.executor ?? new FakeAgentExecutor({ output: { ok: true } });
  const executionEngine =
    options.executionEngine ??
    new ExecutionEngine({
      registry: new StaticExecutorRegistry([executor]),
      config: parseExecutionConfig({
        EXECUTION_EVENTS_ENABLED: 'false',
        EXECUTION_BACKOFF_BASE_MS: '5',
        EXECUTION_BACKOFF_MAX_MS: '10',
      }),
    });
  const events = new InMemoryOrchestratorEventEmitter();

  const service = new MasterOrchestratorService({
    intentClassifier: options.intentClassifier ?? new RuleBasedIntentClassifier(),
    contextBuilder: options.contextBuilder ?? new ContextBuilder(),
    routingEngine:
      options.routingEngine ??
      new RoutingEngine({ registry: options.registry ?? new RoutingRegistry() }),
    planBuilder: options.planBuilder ?? new ExecutionPlanBuilder(),
    executionEngine,
    aggregationService: options.aggregationService ?? new SharedAggregationService(),
    events,
  });

  return { service, executor, events };
}

export type {
  ExecutionPlan,
  ExecutionResult,
  AggregatedResponse,
  RouteDecision,
  IntentResult,
  IntentDefinition,
};
