import type { Logger } from 'pino';

import { createOrchestratorLogger } from '../../utils/logger.js';
import { nowIso } from '../../utils/ids.js';
import { ExecutionMode } from '../../routing/types/index.js';
import { UnsupportedExecutionModeError, ExecutionPlanLimitError } from '../errors/index.js';
import { planningConfig, type PlanningConfig, isModeEnabled } from '../config/index.js';
import { resolveStrategy } from '../strategies/index.js';
import { buildDependencyGraph, estimateExecutionStages } from '../dependencies/index.js';
import { validatePlanningRequest, validatePlan } from '../validators/index.js';
import { defaultPolicy } from '../utils/index.js';
import { safePlanOptimizer } from '../optimizers/index.js';
import type {
  ExecutionBranch,
  ExecutionCondition,
  ExecutionConstraints,
  ExecutionDependency,
  ExecutionMetadata,
  ExecutionPlan,
  ExecutionStep,
  PlanningRequest,
  PlanningStatistics,
  PlanningWarning,
} from '../types/index.js';
import type { ExecutionPlanBuilderContract } from '../interfaces/index.js';

/** Options for constructing the plan builder. */
export interface ExecutionPlanBuilderOptions {
  readonly config?: PlanningConfig;
  readonly logger?: Logger;
  readonly planIdPrefix?: string;
}

/** Plan fragments produced by a strategy and passed through optimization. */
interface PlanFragments {
  readonly steps: readonly ExecutionStep[];
  readonly dependencies: readonly ExecutionDependency[];
  readonly conditions: readonly ExecutionCondition[];
  readonly branches: readonly ExecutionBranch[];
  readonly optimizations: readonly PlanningWarning[];
}

/**
 * Deterministic Execution Planner (Sprint 5, prompt §11). Consumes an
 * AgentRequest, IntentResult, ContextSnapshot and RouteDecision and produces
 * a declarative ExecutionPlan. Pure and read-only: no agent execution,
 * retrieval, tools, LLM or external calls. Same inputs ⇒ same plan.
 */
export class ExecutionPlanBuilder implements ExecutionPlanBuilderContract {
  readonly name = 'execution-plan-builder';
  readonly version = '1.0.0';

  private readonly config: PlanningConfig;
  private readonly logger: Logger;
  private readonly planIdPrefix: string;

  constructor(options: ExecutionPlanBuilderOptions = {}) {
    this.config = options.config ?? planningConfig;
    this.logger = options.logger ?? createOrchestratorLogger('planning');
    this.planIdPrefix = options.planIdPrefix ?? 'plan';
  }

  /** Builds a validated, deterministic execution plan. */
  build(input: PlanningRequest): ExecutionPlan {
    validatePlanningRequest(input);

    const mode = this.resolveMode(input);
    const strategy = resolveStrategy(mode);

    const output = strategy.plan({ request: input, config: this.config });

    const constraints = this.applyConstraints(input);
    const planFragments = this.optimize(output);

    this.assertLimits(constraints, planFragments.steps, planFragments.dependencies);

    const graph = buildDependencyGraph(planFragments.steps, planFragments.dependencies);

    const warnings: PlanningWarning[] = [...output.warnings, ...planFragments.optimizations];

    const statistics = this.statistics(planFragments, graph, warnings);

    const plan: ExecutionPlan = {
      planId: this.createPlanId(input),
      version: this.version,
      createdAt: nowIso(),
      requestId: input.requestId,
      traceId: input.traceId,
      intentId: input.intent.primary.intent.id,
      role: input.role,
      mode,
      steps: planFragments.steps,
      dependencies: planFragments.dependencies,
      conditions: planFragments.conditions,
      branches: planFragments.branches,
      policy: defaultPolicy(this.config),
      constraints,
      metadata: this.metadata(input, planFragments, mode, warnings),
      warnings,
      statistics,
    };

    validatePlan(plan);

    this.logger.info(
      {
        requestId: input.requestId,
        traceId: input.traceId,
        intent: input.intent.primary.intent.id,
        planId: plan.planId,
        executionMode: mode,
        stepCount: planFragments.steps.length,
        dependencyCount: planFragments.dependencies.length,
        warningCount: warnings.length,
        status: 'planned',
      },
      'execution plan produced',
    );

    return plan;
  }

  private resolveMode(input: PlanningRequest): ExecutionMode {
    const mode = input.route.executionMode;

    if (!Object.values(ExecutionMode).includes(mode)) {
      throw new UnsupportedExecutionModeError(`Unsupported execution mode: ${String(mode)}`);
    }

    if (!isModeEnabled(this.config, mode)) {
      throw new UnsupportedExecutionModeError(
        `Execution mode ${mode} is disabled by planning configuration`,
        { details: { executionMode: mode } },
      );
    }

    return mode;
  }

  private applyConstraints(input: PlanningRequest): ExecutionConstraints {
    const maxSteps = Math.min(
      input.constraints?.maxSteps ?? this.config.PLANNING_MAX_STEPS,
      this.config.PLANNING_MAX_STEPS,
    );
    const maxDepth = Math.min(
      input.constraints?.maxDepth ?? this.config.PLANNING_MAX_PLAN_DEPTH,
      this.config.PLANNING_MAX_PLAN_DEPTH,
    );
    const maxParallelBranches = Math.min(
      input.constraints?.maxParallelBranches ?? this.config.PLANNING_MAX_PARALLEL_BRANCHES,
      this.config.PLANNING_MAX_PARALLEL_BRANCHES,
    );
    const maxTotalExecutionTimeMs =
      input.constraints?.maxTotalExecutionTimeMs ??
      this.config.PLANNING_MAX_STEPS * this.config.PLANNING_DEFAULT_TIMEOUT_MS;

    return {
      maxSteps,
      maxDepth,
      maxParallelBranches,
      maxTotalExecutionTimeMs,
    };
  }

  private assertLimits(
    constraints: ExecutionConstraints,
    steps: readonly ExecutionStep[],
    dependencies: readonly ExecutionDependency[],
  ): void {
    if (constraints.maxSteps !== undefined && steps.length > constraints.maxSteps) {
      throw new ExecutionPlanLimitError(
        `Execution plan exceeds maximum steps: ${steps.length} > ${constraints.maxSteps}`,
        { details: { steps: steps.length, maxSteps: constraints.maxSteps } },
      );
    }

    const graph = buildDependencyGraph(steps, dependencies);

    if (constraints.maxDepth !== undefined && graph.maximumDepth > constraints.maxDepth) {
      throw new ExecutionPlanLimitError(
        `Execution plan exceeds maximum depth: ${graph.maximumDepth} > ${constraints.maxDepth}`,
        { details: { depth: graph.maximumDepth, maxDepth: constraints.maxDepth } },
      );
    }

    if (
      constraints.maxParallelBranches !== undefined &&
      graph.roots.length > constraints.maxParallelBranches
    ) {
      throw new ExecutionPlanLimitError(
        `Execution plan exceeds maximum parallel branches: ${graph.roots.length} > ${constraints.maxParallelBranches}`,
        {
          details: {
            branches: graph.roots.length,
            maxParallelBranches: constraints.maxParallelBranches,
          },
        },
      );
    }
  }

  private optimize(output: {
    readonly steps: readonly ExecutionStep[];
    readonly dependencies: readonly ExecutionDependency[];
    readonly conditions: readonly ExecutionCondition[];
    readonly branches: readonly ExecutionBranch[];
    readonly warnings: readonly PlanningWarning[];
  }): PlanFragments {
    if (!this.config.PLANNING_OPTIMIZATION_ENABLED) {
      return {
        steps: output.steps,
        dependencies: output.dependencies,
        conditions: output.conditions,
        branches: output.branches,
        optimizations: [],
      };
    }

    const result = safePlanOptimizer.optimize(output);
    return {
      steps: result.steps,
      dependencies: result.dependencies,
      conditions: result.conditions,
      branches: result.branches,
      optimizations: result.optimizations,
    };
  }

  private statistics(
    fragments: PlanFragments,
    graph: ReturnType<typeof buildDependencyGraph>,
    warnings: readonly PlanningWarning[],
  ): PlanningStatistics {
    const agentCount = new Set(fragments.steps.map((step) => step.agentId)).size;

    return {
      stepCount: fragments.steps.length,
      agentCount,
      dependencyCount: fragments.dependencies.length,
      parallelBranchCount: fragments.branches.length,
      conditionalBranchCount: fragments.branches.length,
      maximumDepth: graph.maximumDepth,
      estimatedExecutionStages: estimateExecutionStages(graph.order, graph.edges),
      optimizationCount: fragments.optimizations.length,
      warningCount: warnings.length,
    };
  }

  private metadata(
    input: PlanningRequest,
    fragments: PlanFragments,
    mode: ExecutionMode,
    warnings: readonly PlanningWarning[],
  ): ExecutionMetadata {
    return {
      version: this.version,
      createdAt: nowIso(),
      planId: this.createPlanId(input),
      requestId: input.requestId,
      traceId: input.traceId,
      intentId: input.intent.primary.intent.id,
      executionMode: mode,
      stepCount: fragments.steps.length,
      dependencyCount: fragments.dependencies.length,
      branchCount: fragments.branches.length,
      conditionCount: fragments.conditions.length,
      optimizationCount: fragments.optimizations.length,
      warningCount: warnings.length,
    };
  }

  private createPlanId(input: PlanningRequest): string {
    const id = input.requestId ?? input.traceId ?? 'anonymous';
    return `${this.planIdPrefix}-${id}`;
  }
}

export { validatePlanningRequest };
