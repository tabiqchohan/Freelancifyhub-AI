import type { ExecutionMode } from '../../routing/types/index.js';
import type {
  ExecutionBranch,
  ExecutionCondition,
  ExecutionDependency,
  ExecutionPlan,
  ExecutionStep,
  PlanningRequest,
  PlanningWarning,
} from '../types/index.js';
import type { PlanningConfig } from '../config/index.js';

/** Output a strategy produces: the pieces of an execution plan (prompt §12). */
export interface StrategyOutput {
  readonly steps: readonly ExecutionStep[];
  readonly dependencies: readonly ExecutionDependency[];
  readonly conditions: readonly ExecutionCondition[];
  readonly branches: readonly ExecutionBranch[];
  readonly warnings: readonly PlanningWarning[];
}

/**
 * Input a planning strategy needs. Strategies plan structures only; they
 * never execute agents (prompt §12).
 */
export interface StrategyInput {
  readonly request: PlanningRequest;
  readonly config: PlanningConfig;
}

/** Contract any execution planning strategy must satisfy (prompt §12). */
export interface ExecutionPlanningStrategy {
  readonly name: string;
  readonly mode: ExecutionMode;
  plan(input: StrategyInput): StrategyOutput;
}

/** Contract the plan builder must satisfy (prompt §11). */
export interface ExecutionPlanBuilderContract {
  readonly name: string;
  readonly version: string;
  build(input: PlanningRequest): ExecutionPlan;
}

/** Contract any safe plan optimizer must satisfy (prompt §17). */
export interface ExecutionPlanOptimizer {
  readonly name: string;
  optimize(
    plan: Readonly<Pick<ExecutionPlan, 'steps' | 'dependencies' | 'conditions' | 'branches'>>,
  ): {
    readonly steps: readonly ExecutionStep[];
    readonly dependencies: readonly ExecutionDependency[];
    readonly conditions: readonly ExecutionCondition[];
    readonly branches: readonly ExecutionBranch[];
    readonly optimizations: readonly PlanningWarning[];
  };
}
