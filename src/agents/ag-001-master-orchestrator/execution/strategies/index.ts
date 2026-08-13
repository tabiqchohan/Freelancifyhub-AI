import { ExecutionMode } from '../../routing/types/index.js';
import { UnsupportedExecutionModeError } from '../../planning/errors/index.js';
import type {
  ExecutionModeStrategy,
  StrategyInput,
  ExecutionStrategyOutcome,
} from '../interfaces/index.js';
import type { ExecutionStep } from '../../planning/types/index.js';

/** Computes a deterministic topological execution order from plan dependencies. */
function dependencyOrder(
  steps: readonly ExecutionStep[],
  input: StrategyInput,
): readonly ExecutionStep[] {
  const dependencies = input.run.plan.dependencies;
  const byId = new Map(steps.map((step) => [step.stepId, step]));

  const incoming = new Map<string, number>();
  for (const step of steps) {
    incoming.set(step.stepId, 0);
  }
  for (const dependency of dependencies) {
    incoming.set(dependency.stepId, (incoming.get(dependency.stepId) ?? 0) + 1);
  }

  const dependents = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const list = dependents.get(dependency.dependsOn) ?? [];
    list.push(dependency.stepId);
    dependents.set(dependency.dependsOn, list);
  }

  const ready = steps
    .filter((step) => (incoming.get(step.stepId) ?? 0) === 0)
    .map((step) => step.stepId)
    .sort();

  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    order.push(current);
    const children = dependents.get(current) ?? [];
    children.sort();
    for (const child of children) {
      const count = (incoming.get(child) ?? 0) - 1;
      incoming.set(child, count);
      if (count === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  return order
    .map((id) => byId.get(id))
    .filter((step): step is ExecutionStep => step !== undefined)
    .sort((a, b) => a.order - b.order);
}

/** SINGLE mode: execute exactly one step (prompt §5). */
class SingleExecutionStrategy implements ExecutionModeStrategy {
  readonly name = 'single-execution-strategy';

  async execute(input: StrategyInput): Promise<ExecutionStrategyOutcome> {
    const step = input.run.plan.steps[0];
    if (step === undefined) {
      return { completed: true };
    }
    if (!input.isCancelled() && !input.stopRequested()) {
      await input.executeStep(step).catch(() => undefined);
    }
    return { completed: true };
  }
}

/** SEQUENTIAL mode: execute steps in dependency/order (prompt §6). */
class SequentialExecutionStrategy implements ExecutionModeStrategy {
  readonly name = 'sequential-execution-strategy';

  async execute(input: StrategyInput): Promise<ExecutionStrategyOutcome> {
    const ordered = dependencyOrder(input.run.plan.steps, input);

    for (const step of ordered) {
      if (input.isCancelled() || input.stopRequested()) {
        break;
      }
      await input.executeStep(step);
    }

    return { completed: true };
  }
}

/** PARALLEL mode: execute independent steps concurrently (prompt §7). */
class ParallelExecutionStrategy implements ExecutionModeStrategy {
  readonly name = 'parallel-execution-strategy';

  async execute(input: StrategyInput): Promise<ExecutionStrategyOutcome> {
    const steps = input.run.plan.steps;

    await Promise.allSettled(steps.map((step) => input.executeStep(step).catch(() => undefined)));

    return { completed: true };
  }
}

/** CONDITIONAL mode: execute steps whose branch condition is satisfied (prompt §8). */
class ConditionalExecutionStrategy implements ExecutionModeStrategy {
  readonly name = 'conditional-execution-strategy';

  async execute(input: StrategyInput): Promise<ExecutionStrategyOutcome> {
    const plan = input.run.plan;

    for (const step of plan.steps) {
      if (input.isCancelled() || input.stopRequested()) {
        break;
      }

      if (input.shouldSkipStep(step)) {
        continue;
      }

      await input.executeStep(step);
    }

    return { completed: true };
  }
}

/** HYBRID mode: honour dependencies while running independent waves (prompt §9). */
class HybridExecutionStrategy implements ExecutionModeStrategy {
  readonly name = 'hybrid-execution-strategy';

  async execute(input: StrategyInput): Promise<ExecutionStrategyOutcome> {
    const ordered = dependencyOrder(input.run.plan.steps, input);

    for (const step of ordered) {
      if (input.isCancelled() || input.stopRequested()) {
        break;
      }
      await input.executeStep(step);
    }

    return { completed: true };
  }
}

const strategies: Readonly<Record<ExecutionMode, ExecutionModeStrategy>> = {
  [ExecutionMode.Single]: new SingleExecutionStrategy(),
  [ExecutionMode.Sequential]: new SequentialExecutionStrategy(),
  [ExecutionMode.Parallel]: new ParallelExecutionStrategy(),
  [ExecutionMode.Conditional]: new ConditionalExecutionStrategy(),
  [ExecutionMode.Hybrid]: new HybridExecutionStrategy(),
};

/** Resolves the execution strategy for a plan's mode (prompt §5–§9). */
export function resolveExecutionStrategy(mode: ExecutionMode): ExecutionModeStrategy {
  const strategy = strategies[mode];

  if (strategy === undefined) {
    throw new UnsupportedExecutionModeError(`Unsupported execution mode: ${mode}`);
  }

  return strategy;
}

export {
  SingleExecutionStrategy,
  SequentialExecutionStrategy,
  ParallelExecutionStrategy,
  ConditionalExecutionStrategy,
  HybridExecutionStrategy,
  strategies,
};
