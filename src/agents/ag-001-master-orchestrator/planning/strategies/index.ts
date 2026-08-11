import { ExecutionMode } from '../../routing/types/index.js';
import type { AgentRoute, RouteCandidate } from '../../routing/types/index.js';
import { ExecutionPlanValidationError, UnsupportedExecutionModeError } from '../errors/index.js';
import type {
  ExecutionPlanningStrategy,
  StrategyInput,
  StrategyOutput,
} from '../interfaces/index.js';
import type { ExecutionBranch, ExecutionCondition, ExecutionStep } from '../types/index.js';
import { ConditionOperator, ExecutionStatus } from '../types/index.js';
import {
  branchId,
  buildInputReferences,
  conditionId,
  defaultPolicy,
  defaultRetry,
  outputReference,
  requiredCapabilities,
  stepId,
} from '../utils/index.js';

/** Builds a single execution step from a routed agent (prompt §3). */
function stepFromAgent(
  input: StrategyInput,
  agent: AgentRoute,
  index: number,
  dependencies: readonly {
    readonly stepId: string;
    readonly dependsOn: string;
    readonly required: boolean;
  }[] = [],
): ExecutionStep {
  const policy = defaultPolicy(input.config);
  const id = stepId(index);

  return {
    stepId: id,
    agentId: agent.agent.agentId,
    order: index,
    capabilities: requiredCapabilities(agent.agent),
    dependencies,
    input: buildInputReferences(index),
    output: [outputReference(id)],
    policy,
    status: ExecutionStatus.Pending,
    timeoutMs: policy.timeoutMs,
    retry: defaultRetry(input.config),
  };
}

/** Builds a step for a candidate agent (used by multi-agent modes). */
function stepFromCandidate(
  input: StrategyInput,
  candidate: RouteCandidate,
  index: number,
  dependencies: readonly {
    readonly stepId: string;
    readonly dependsOn: string;
    readonly required: boolean;
  }[] = [],
): ExecutionStep {
  return stepFromAgent(
    input,
    {
      agent: candidate.agent,
      score: candidate.score,
      confidence: candidate.confidence,
      strategy: candidate.strategy,
      reasons: candidate.reasons,
    },
    index,
    dependencies,
  );
}

function assertRoutable(input: StrategyInput): void {
  const route = input.request.route;

  if (route.status === 'failed') {
    throw new ExecutionPlanValidationError('Cannot plan an execution for a failed route', {
      details: { intentId: route.intentId },
    });
  }

  if (route.status === 'escalated') {
    throw new ExecutionPlanValidationError('Cannot plan an execution for an escalated route', {
      details: { intentId: route.intentId },
    });
  }
}

function selectedAgentOrThrow(input: StrategyInput): AgentRoute {
  const route = input.request.route;

  if (route.selectedAgent === undefined) {
    throw new ExecutionPlanValidationError(
      'Route decision has no selected agent; cannot build an execution plan',
      { details: { intentId: route.intentId, status: route.status } },
    );
  }

  return route.selectedAgent;
}

/** SINGLE mode: one step for the selected agent (prompt §3). */
class SinglePlanningStrategy implements ExecutionPlanningStrategy {
  readonly name = 'single-planning-strategy';
  readonly mode = ExecutionMode.Single;

  plan(input: StrategyInput): StrategyOutput {
    assertRoutable(input);
    const agent = selectedAgentOrThrow(input);

    return {
      steps: [stepFromAgent(input, agent, 0)],
      dependencies: [],
      conditions: [],
      branches: [],
      warnings: [],
    };
  }
}

/** SEQUENTIAL mode: ordered steps, each depending on the previous (prompt §4). */
class SequentialPlanningStrategy implements ExecutionPlanningStrategy {
  readonly name = 'sequential-planning-strategy';
  readonly mode = ExecutionMode.Sequential;

  plan(input: StrategyInput): StrategyOutput {
    assertRoutable(input);

    const candidates = input.request.route.candidates;
    if (candidates.length === 0) {
      throw new ExecutionPlanValidationError(
        'Cannot build a sequential plan without route candidates',
      );
    }

    const steps: ExecutionStep[] = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const dependencies =
        index > 0
          ? [
              {
                stepId: stepId(index),
                dependsOn: stepId(index - 1),
                required: true,
              },
            ]
          : [];
      steps.push(stepFromCandidate(input, candidate, index, dependencies));
    }

    const dependencies = steps.flatMap((step) => step.dependencies);

    return {
      steps,
      dependencies,
      conditions: [],
      branches: [],
      warnings: [],
    };
  }
}

/** PARALLEL mode: independent steps with no dependencies between them (prompt §5). */
class ParallelPlanningStrategy implements ExecutionPlanningStrategy {
  readonly name = 'parallel-planning-strategy';
  readonly mode = ExecutionMode.Parallel;

  plan(input: StrategyInput): StrategyOutput {
    assertRoutable(input);

    const candidates = input.request.route.candidates;
    if (candidates.length === 0) {
      throw new ExecutionPlanValidationError(
        'Cannot build a parallel plan without route candidates',
      );
    }

    const steps: ExecutionStep[] = [];

    for (let index = 0; index < candidates.length; index += 1) {
      steps.push(stepFromCandidate(input, candidates[index]!, index));
    }

    return {
      steps,
      dependencies: [],
      conditions: [],
      branches: [],
      warnings: [],
    };
  }
}

/** CONDITIONAL mode: branches on a declarative confidence condition (prompt §6). */
class ConditionalPlanningStrategy implements ExecutionPlanningStrategy {
  readonly name = 'conditional-planning-strategy';
  readonly mode = ExecutionMode.Conditional;

  plan(input: StrategyInput): StrategyOutput {
    assertRoutable(input);

    const route = input.request.route;
    const candidates = route.candidates;
    if (candidates.length === 0) {
      throw new ExecutionPlanValidationError(
        'Cannot build a conditional plan without route candidates',
      );
    }

    const primaryAgent = selectedAgentOrThrow(input);
    const threshold = route.confidenceThreshold;

    const primaryStep = stepFromAgent(input, primaryAgent, 0);
    const steps: ExecutionStep[] = [primaryStep];

    const ifCondition: ExecutionCondition = {
      id: conditionId(0),
      operator: ConditionOperator.GreaterThan,
      field: 'route.confidence',
      value: threshold,
    };

    const conditions: ExecutionCondition[] = [ifCondition];
    const branches: ExecutionBranch[] = [
      {
        branchId: branchId(0),
        condition: ifCondition,
        stepIds: [primaryStep.stepId],
        order: 0,
      },
    ];

    if (candidates.length > 1) {
      const elseStep = stepFromCandidate(input, candidates[1]!, 1);
      steps.push(elseStep);

      const elseCondition: ExecutionCondition = {
        id: conditionId(1),
        operator: ConditionOperator.Not,
        children: [ifCondition.id],
      };

      conditions.push(elseCondition);
      branches.push({
        branchId: branchId(1),
        condition: elseCondition,
        stepIds: [elseStep.stepId],
        order: 1,
      });
    }

    return {
      steps,
      dependencies: [],
      conditions,
      branches,
      warnings: [],
    };
  }
}

/** HYBRID mode: sequential prefix, parallel middle, conditional tail (prompt §7). */
class HybridPlanningStrategy implements ExecutionPlanningStrategy {
  readonly name = 'hybrid-planning-strategy';
  readonly mode = ExecutionMode.Hybrid;

  plan(input: StrategyInput): StrategyOutput {
    assertRoutable(input);

    const candidates = input.request.route.candidates;
    if (candidates.length === 0) {
      throw new ExecutionPlanValidationError('Cannot build a hybrid plan without route candidates');
    }

    if (candidates.length < 3) {
      throw new ExecutionPlanValidationError(
        `Hybrid planning requires at least 3 candidates, got ${candidates.length}`,
      );
    }

    const steps: ExecutionStep[] = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const stepDependencies: {
        readonly stepId: string;
        readonly dependsOn: string;
        readonly required: boolean;
      }[] = [];

      if (index === 0) {
        // root step: no dependencies
      } else if (index === candidates.length - 1) {
        // final step depends on every middle (parallel) step
        for (let mid = 1; mid < candidates.length - 1; mid += 1) {
          stepDependencies.push({
            stepId: stepId(index),
            dependsOn: stepId(mid),
            required: true,
          });
        }
      } else {
        // middle (parallel) steps depend on the sequential prefix
        stepDependencies.push({
          stepId: stepId(index),
          dependsOn: stepId(0),
          required: true,
        });
      }

      steps.push(stepFromCandidate(input, candidates[index]!, index, stepDependencies));
    }

    const dependencies = steps.flatMap((step) => step.dependencies);

    return {
      steps,
      dependencies,
      conditions: [],
      branches: [],
      warnings: [],
    };
  }
}

const strategies: Readonly<Record<ExecutionMode, ExecutionPlanningStrategy>> = {
  [ExecutionMode.Single]: new SinglePlanningStrategy(),
  [ExecutionMode.Sequential]: new SequentialPlanningStrategy(),
  [ExecutionMode.Parallel]: new ParallelPlanningStrategy(),
  [ExecutionMode.Conditional]: new ConditionalPlanningStrategy(),
  [ExecutionMode.Hybrid]: new HybridPlanningStrategy(),
};

/** Resolves the strategy for a route decision execution mode (prompt §10). */
export function resolveStrategy(mode: ExecutionMode): ExecutionPlanningStrategy {
  const strategy = strategies[mode];

  if (strategy === undefined) {
    throw new UnsupportedExecutionModeError(`Unsupported execution mode: ${mode}`);
  }

  return strategy;
}

export {
  SinglePlanningStrategy,
  SequentialPlanningStrategy,
  ParallelPlanningStrategy,
  ConditionalPlanningStrategy,
  HybridPlanningStrategy,
  strategies,
};
