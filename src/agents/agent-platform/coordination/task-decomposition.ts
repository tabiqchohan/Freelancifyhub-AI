/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Deterministic task
 * decomposition and plan building (Sprint 20 §5/§6).
 *
 * Plan building is deterministic-first: AG-001 supplies pre-built tasks (the
 * preferred path) or the planner auto-decomposes a participant list into a
 * mode-shaped dependency graph:
 *   SINGLE    → one task
 *   SEQUENTIAL→ chain (A → B → C)
 *   PIPELINE  → chain (A → B → C)
 *   PARALLEL  → no edges (all concurrent)
 *   DEBATE    → no edges (independent; aggregation strategy drives review)
 *   HYBRID    → chain (deterministic v1; richer shapes come from AG-001 tasks)
 *
 * The plan is validated by the {@link TaskDependencyGraph} (duplicates, cycles,
 * unknown/self dependencies) and every target agent passes
 * {@link AgentSelector}. Invalid plans fail before any execution.
 */

import {
  COORDINATION_DEFAULT_MAX_CONCURRENT_TASKS as DEFAULT_MAX_CONCURRENT_TASKS,
  COORDINATION_DEFAULT_MAX_TASKS_PER_AGENT as DEFAULT_MAX_TASKS_PER_AGENT,
  COORDINATION_DEFAULT_GLOBAL_TIMEOUT_MS as DEFAULT_GLOBAL_TIMEOUT_MS,
  COORDINATION_DEFAULT_TASK_TIMEOUT_MS as DEFAULT_TASK_TIMEOUT_MS,
  COORDINATION_MAX_MESSAGE_BYTES,
  COORDINATION_DEFAULT_RETRY,
  COORDINATION_MAX_TASKS,
} from './constants.js';
import { CoordinationPlanInvalidError, CoordinationLimitError } from './errors.js';
import {
  AggregationStrategy,
  ConflictPolicy,
  CoordinationMode,
  TaskFailurePolicy,
} from './types.js';
import type {
  CoordinationLimits,
  CoordinationPlan,
  CoordinationRequest,
  CoordinationTaskInput,
  TaskDependency,
  AgentTask,
} from './types.js';
import { TaskStatus } from './types.js';
import { createCoordinationIdFactory, resolveCoordinationId } from './ids.js';
import { type AgentSelector } from './agent-selection.js';
import { coordinationIdSchema, coordinationTaskIdSchema } from './schemas.js';
import { TaskDependencyGraph } from './dependency-graph.js';

/** Zod-schema pattern for task ids, reused for deterministic auto-ids. */
const TASK_ID_SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

/** Resolved defaults that always satisfy CoordinationLimits. */
const DEFAULT_LIMITS: CoordinationLimits = {
  maxTasks: COORDINATION_MAX_TASKS,
  maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
  maxTasksPerAgent: DEFAULT_MAX_TASKS_PER_AGENT,
  globalTimeoutMs: DEFAULT_GLOBAL_TIMEOUT_MS,
  defaultTaskTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  maxMessageBytes: COORDINATION_MAX_MESSAGE_BYTES,
};

/** Applies user-provided partial limits on top of server defaults, bounded. */
export function resolveLimits(input?: Partial<CoordinationLimits>): CoordinationLimits {
  if (input === undefined) {
    return { ...DEFAULT_LIMITS };
  }
  const combined = { ...DEFAULT_LIMITS, ...input };
  if (combined.maxTasks < 1 || combined.maxTasks > COORDINATION_MAX_TASKS) {
    throw new CoordinationLimitError(`maxTasks must be 1..${COORDINATION_MAX_TASKS}`, {
      value: combined.maxTasks,
    });
  }
  if (combined.maxConcurrentTasks < 1 || combined.maxConcurrentTasks > COORDINATION_MAX_TASKS) {
    throw new CoordinationLimitError(`maxConcurrentTasks must be 1..${COORDINATION_MAX_TASKS}`, {
      value: combined.maxConcurrentTasks,
    });
  }
  if (combined.maxTasksPerAgent < 1 || combined.maxTasksPerAgent > COORDINATION_MAX_TASKS) {
    throw new CoordinationLimitError(`maxTasksPerAgent must be 1..${COORDINATION_MAX_TASKS}`, {
      value: combined.maxTasksPerAgent,
    });
  }
  if (combined.globalTimeoutMs < 1 || combined.globalTimeoutMs > 3600_000) {
    throw new CoordinationLimitError('globalTimeoutMs must be 1..3600000', {
      value: combined.globalTimeoutMs,
    });
  }
  if (combined.defaultTaskTimeoutMs < 1 || combined.defaultTaskTimeoutMs > 600_000) {
    throw new CoordinationLimitError('defaultTaskTimeoutMs must be 1..600000', {
      value: combined.defaultTaskTimeoutMs,
    });
  }
  if (combined.maxMessageBytes < 1024 || combined.maxMessageBytes > 1_048_576) {
    throw new CoordinationLimitError('maxMessageBytes must be 1024..1048576', {
      value: combined.maxMessageBytes,
    });
  }
  return Object.freeze(combined);
}

/** Options for the coordination planner. */
export interface CoordinationPlannerOptions {
  readonly now?: () => string;
  readonly coordinationIdFactory?: () => string;
}

/** Builds validated {@link CoordinationPlan}s from coordination requests. */
export class CoordinationPlanner {
  readonly name = 'coordination-planner';

  private readonly selector: AgentSelector;
  private readonly now: () => string;
  private readonly coordinationIdFactory: () => string;

  constructor(selector: AgentSelector, options: CoordinationPlannerOptions = {}) {
    this.selector = selector;
    this.now = options.now ?? (() => new Date().toISOString());
    this.coordinationIdFactory = options.coordinationIdFactory ?? createCoordinationIdFactory();
  }

  /** Builds, validates and returns a plan (throws on invalid input). */
  plan(request: CoordinationRequest): CoordinationPlan {
    const coordinationId =
      request.coordinationId ?? resolveCoordinationId(this.coordinationIdFactory);
    coordinationIdSchema.parse(coordinationId);
    const limits = resolveLimits(request.limits);
    const tasksInput = request.tasks ?? [];
    if (tasksInput.length === 0 && request.participatingAgents !== undefined) {
      const decomposed = this.decompose(request, limits);
      return this.buildPlan(coordinationId, request, limits, decomposed);
    }
    if (tasksInput.length === 0) {
      throw new CoordinationPlanInvalidError(
        'coordination request must provide tasks or participatingAgents',
        {},
      );
    }
    if (tasksInput.length > limits.maxTasks) {
      throw new CoordinationLimitError(
        `coordination has ${tasksInput.length} tasks but limit is ${limits.maxTasks}`,
        { count: tasksInput.length, limit: limits.maxTasks },
      );
    }
    return this.buildPlan(coordinationId, request, limits, tasksInput);
  }

  /** Auto-decomposes participating agents into mode-shaped tasks. */
  decompose(
    request: CoordinationRequest,
    limits: CoordinationLimits,
  ): readonly CoordinationTaskInput[] {
    const agents = request.participatingAgents ?? [];
    if (agents.length === 0) {
      throw new CoordinationPlanInvalidError(
        'decomposition requires at least one participating agent',
        {},
      );
    }
    if (agents.length > limits.maxTasks) {
      throw new CoordinationLimitError(
        `decomposition has ${agents.length} agents but limit is ${limits.maxTasks}`,
        { count: agents.length, limit: limits.maxTasks },
      );
    }
    if (request.mode === CoordinationMode.Single && agents.length !== 1) {
      throw new CoordinationPlanInvalidError(
        'SINGLE mode requires exactly one participating agent',
        { agents },
      );
    }
    const chain =
      request.mode === CoordinationMode.Sequential || request.mode === CoordinationMode.Pipeline;
    const tasks: CoordinationTaskInput[] = [];
    for (const [index, agentId] of agents.entries()) {
      const taskId = `t${index + 1}`;
      if (!TASK_ID_SAFE.test(taskId)) {
        throw new CoordinationPlanInvalidError(`invalid generated task id ${taskId}`, { taskId });
      }
      const dependencies = chain && index > 0 ? [`t${index}`] : [];
      tasks.push({
        taskId,
        agentId,
        objective:
          index === 0
            ? `execute the overall objective: ${request.objective}`
            : `continue the coordination objective: ${request.objective}`,
        dependencies,
        requiredCapabilities: [],
        requiredTools: [],
        priority: chain ? -index : 0,
        timeoutMs: limits.defaultTaskTimeoutMs,
        retry: { ...COORDINATION_DEFAULT_RETRY },
      });
    }
    return tasks;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildPlan(
    coordinationId: string,
    request: CoordinationRequest,
    limits: CoordinationLimits,
    tasksInput: readonly CoordinationTaskInput[],
  ): CoordinationPlan {
    // Normalize each task.
    const tasks: AgentTask[] = tasksInput.map((input, index) => {
      const taskId = (input.taskId ?? `t${index + 1}`).toString();
      coordinationTaskIdSchema.parse(taskId);
      const dependencies = [...(input.dependencies ?? [])];
      for (const dep of dependencies) {
        coordinationTaskIdSchema.parse(dep);
      }
      if (dependencies.includes(taskId)) {
        throw new CoordinationPlanInvalidError(`task ${taskId} depends on itself`, { taskId });
      }
      const timeoutMs =
        input.timeoutMs ?? Math.min(limits.defaultTaskTimeoutMs, limits.globalTimeoutMs);
      if (timeoutMs < 1 || timeoutMs > limits.globalTimeoutMs) {
        throw new CoordinationLimitError(
          `task ${taskId} timeout ${timeoutMs}ms exceeds coordination limit ${limits.globalTimeoutMs}ms`,
          { taskId, timeoutMs, limit: limits.globalTimeoutMs },
        );
      }
      return {
        taskId,
        agentId: input.agentId,
        coordinationId,
        objective: input.objective,
        input: pipeInput(input.input),
        dependencies: Object.freeze(dependencies),
        requiredCapabilities: Object.freeze([...(input.requiredCapabilities ?? [])]),
        requiredTools: Object.freeze([...(input.requiredTools ?? [])]),
        priority: input.priority ?? 0,
        timeoutMs,
        retry: input.retry ?? { ...COORDINATION_DEFAULT_RETRY },
        status: TaskStatus.Pending,
        createdAt: this.now(),
      };
    });

    // Dependency edges (declared dependencies are required by default).
    const dependencies: TaskDependency[] = [];
    const seenEdges = new Set<string>();
    for (const task of tasks) {
      for (const dep of task.dependencies) {
        const key = `${task.taskId}->${dep}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          dependencies.push({ taskId: task.taskId, dependsOn: dep, required: true });
        }
      }
    }

    // Validate the graph structurally (duplicates, cycles, unknown targets).
    new TaskDependencyGraph(tasks, dependencies);

    // Veto plans where any target agent is not selectable right now.
    this.selector.assertAll(tasks);

    return {
      coordinationId,
      mode: request.mode,
      tasks: Object.freeze(tasks),
      dependencies: Object.freeze(dependencies),
      limits,
      failurePolicy: request.failurePolicy ?? TaskFailurePolicy.FailFast,
      conflictPolicy: request.conflictPolicy ?? ConflictPolicy.FailOnConflict,
      aggregation: request.aggregation ?? AggregationStrategy.Collect,
      createdAt: this.now(),
    };
  }
}

/** Safe normalization of task input (never mutated). */
function pipeInput(input: unknown): Readonly<Record<string, unknown>> {
  if (input === undefined) {
    return {};
  }
  if (typeof input === 'object' && input !== null) {
    return Object.freeze({ ...(input as Record<string, unknown>) });
  }
  return Object.freeze({ value: input });
}
