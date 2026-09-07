/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. The execution
 * coordinator (Sprint 20 §4–§22).
 *
 * Orchestrates one coordination run end-to-end:
 *
 *   1. plan (decomposition + validation + agent selection),
 *   2. dispatch with topological order, per-run/per-agent concurrency,
 *      coordinator-owned retries, task+global deadlines, cancellation,
 *   3. collect validated results,
 *   4. detect + resolve conflicts per policy,
 *   5. aggregate per strategy,
 *   6. emit deterministic slow-path events and metrics; return the final
 *      {@link CoordinationResult}.
 *
 * Invocations ALWAYS flow through the runtime executor (Sprint 19 gate). The
 * coordinator never bypasses AG-001, the gateway, lifecycle, authorization, or
 * the LLM layer.
 */

import type { IsoTimestamp } from '../../ag-001-master-orchestrator/types/index.js';
import type { CoordinationEventLog } from './events.js';
import {
  agentSelectedEvent,
  conflictDetectedEvent,
  coordinationCancelledEvent,
  coordinationCompletedEvent,
  coordinationCreatedEvent,
  coordinationFailedEvent,
  coordinationStartedEvent,
  resultReceivedEvent,
  taskCancelledEvent,
  taskCompletedEvent,
  taskCreatedEvent,
  taskFailedEvent,
  taskReadyEvent,
  taskRetryingEvent,
  taskStartedEvent,
  taskTimedOutEvent,
} from './events.js';
import { CoordinationCancelledError } from './errors.js';
import { CoordinationMetrics } from './metrics.js';
import type { CoordinationEvent, CoordinationEventInput } from './events.js';
import { type CoordinationPlanner } from './task-decomposition.js';
import type { InvocationOutcome } from './invocation.js';
import { type RuntimeAgentInvocationAdapter } from './invocation.js';
import { TaskStatus } from './types.js';
import type {
  CoordinationResult,
  CoordinationAggregate,
  CoordinationPlan,
  CoordinationRequest,
  TaskResult,
} from './types.js';
import { CoordinationStatus, CoordinationPhase, TaskFailurePolicy } from './types.js';
import { type CoordinationStateStore, createCoordinationState } from './coordination-state.js';
import { TaskDependencyGraph } from './dependency-graph.js';
import { detectConflicts, resolveConflicts, throwIfConflictsFail } from './conflict.js';
import { aggregateResults } from './aggregation.js';
import { decideRetry, waitForBackoff } from './retry.js';
import { parseCoordinationRequest } from './schemas.js';

export type { CoordinationResult };

/** Options for the coordination coordinator. */
export interface CoordinationCoordinatorOptions {
  readonly planner: CoordinationPlanner;
  readonly invocation: RuntimeAgentInvocationAdapter;
  readonly eventLog?: CoordinationEventLog;
  readonly metrics?: CoordinationMetrics;
  readonly now?: () => string;
}

/** Health/status surface for the runtime (drives the health block). */
export interface CoordinationCoordinatorStatus {
  readonly healthy: boolean;
  readonly activeCoordinations: number;
  readonly activeTaskCount: number;
  readonly metrics: ReturnType<CoordinationMetrics['snapshot']>;
  readonly eventCount: number;
}

interface RunningTask {
  readonly taskId: string;
  readonly agentId: string;
}

/** Deterministic, bounded coordination executor. */
export class CoordinationCoordinator {
  readonly name = 'coordination-coordinator';
  readonly version = '1.0.0';

  private readonly planner: CoordinationPlanner;
  private readonly invocation: RuntimeAgentInvocationAdapter;
  private readonly eventLog?: CoordinationEventLog;
  private readonly metrics: CoordinationMetrics;
  private readonly now: () => string;
  private readonly active = new Map<string, CoordinationStateStore>();
  private readonly attemptsByKey = new Map<string, number>();

  constructor(options: CoordinationCoordinatorOptions) {
    this.planner = options.planner;
    this.invocation = options.invocation;
    this.eventLog = options.eventLog;
    this.metrics = options.metrics ?? new CoordinationMetrics();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Runs a coordination end-to-end and returns the final result. */
  async coordinate(request: CoordinationRequest): Promise<CoordinationResult> {
    const parsed = parseCoordinationRequest(request);
    const plan = this.planner.plan(parsed);
    const startedAt = this.now();
    const state = createCoordinationState(plan, startedAt);
    this.active.set(plan.coordinationId, state);
    this.metrics.recordCoordinationStarted();
    this.emit(coordinationCreatedEvent, { coordinationId: plan.coordinationId });

    const removeAbort = attachAbortHandlers(parsed.cancellation, () => {
      state.markCancelled(this.now());
      void this.cancelOutstanding(state, plan);
    });

    let result: CoordinationResult | undefined;
    try {
      state.enterDispatching(this.now());
      this.emit(coordinationStartedEvent, { coordinationId: plan.coordinationId });
      // Global deadline (server-controlled; unref'd so it never holds the loop).
      state.armDeadline(plan.limits.globalTimeoutMs, () => {
        state.markDeadlineReached(this.now());
        void this.cancelOutstanding(state, plan);
      });

      await this.dispatch(plan, state, parsed);

      if (state.isCancelled) {
        result = this.finalize(
          plan,
          state,
          startedAt,
          parsed.correlationId,
          CoordinationStatus.Cancelled,
          undefined,
          true,
          undefined,
        );
      } else if (state.isDeadlineReached) {
        result = this.finalize(
          plan,
          state,
          startedAt,
          parsed.correlationId,
          CoordinationStatus.TimedOut,
          undefined,
          false,
          true,
        );
      } else {
        result = this.complete(plan, state, startedAt, parsed.correlationId);
      }
    } catch (error) {
      const cancelled = state.isCancelled;
      const timedOut = state.isDeadlineReached;
      const status = cancelled
        ? CoordinationStatus.Cancelled
        : timedOut
          ? CoordinationStatus.TimedOut
          : CoordinationStatus.Failed;
      await this.cancelOutstanding(state, plan);
      result = this.finalize(
        plan,
        state,
        startedAt,
        parsed.correlationId,
        status,
        error,
        cancelled,
        timedOut,
      );
    } finally {
      removeAbort();
      this.active.delete(plan.coordinationId);
      state.clearTimer();
      if (result !== undefined) {
        this.metrics.recordCoordinationCompleted(
          resultIsPostHocTerminal(result),
          durationMsSince(startedAt, this.now()),
        );
      }
    }
    return result;
  }

  /** Cancel a live coordination (external callers). */
  async cancel(coordinationId: string, _reason?: string): Promise<boolean> {
    const state = this.active.get(coordinationId);
    if (state === undefined) {
      return false;
    }
    state.markCancelled(this.now());
    await this.cancelOutstanding(state, state.planOf);
    return true;
  }

  /** Health/status used by the runtime health block. */
  status(): CoordinationCoordinatorStatus {
    const snapshot = this.metrics.snapshot();
    return {
      healthy: snapshot.counts.failedCoordinations === 0,
      activeCoordinations: snapshot.gauges.activeCoordinations,
      activeTaskCount: this.active.size,
      metrics: snapshot,
      eventCount: this.eventLog?.count() ?? 0,
    };
  }

  /** Read-only status of a specific coordination (post-hoc introspection). */
  peek(coordinationId: string): CoordinationStateStore | undefined {
    return this.active.get(coordinationId);
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private async dispatch(
    plan: CoordinationPlan,
    state: CoordinationStateStore,
    request: CoordinationRequest,
  ): Promise<void> {
    const graph = new TaskDependencyGraph(plan.tasks, plan.dependencies);
    for (const task of plan.tasks) {
      this.emit(taskCreatedEvent, {
        coordinationId: plan.coordinationId,
        taskId: task.taskId,
        agentId: task.agentId,
      });
    }

    const running = new Map<string, RunningTask>();
    let waiter: (() => void) | undefined;

    const notify = (): void => {
      if (waiter !== undefined) {
        const resolve = waiter;
        waiter = undefined;
        resolve();
      }
    };

    const waitForSettled = (): Promise<void> =>
      new Promise<void>((resolve) => {
        waiter = resolve;
      });

    const startTask = async (task: (typeof plan.tasks)[number]): Promise<void> => {
      try {
        let attempts = 0;
        state.grantReady(task.taskId, state.statusOf(task.taskId));
        this.emit(taskReadyEvent, {
          coordinationId: plan.coordinationId,
          taskId: task.taskId,
          agentId: task.agentId,
        });
        state.startTask(task.taskId, TaskStatus.Ready);
        this.emit(taskStartedEvent, {
          coordinationId: plan.coordinationId,
          taskId: task.taskId,
          agentId: task.agentId,
        });

        for (;;) {
          if (isAborted(request.cancellation) || state.isCancelled) {
            throw new CoordinationCancelledError('coordination cancelled while dispatching', {
              coordinationId: plan.coordinationId,
              taskId: task.taskId,
            });
          }
          attempts += 1;
          this.attemptsByKey.set(attemptKey(plan.coordinationId, task.taskId), attempts);
          const startedAt = this.now();
          const outcome = await this.invocation.invoke(task, attempts);
          if (outcome.success) {
            this.recordTask(plan, state, task, outcome, startedAt, TaskStatus.Completed);
            this.emit(resultReceivedEvent, {
              coordinationId: plan.coordinationId,
              taskId: task.taskId,
              agentId: task.agentId,
            });
            return;
          }
          const decision = decideRetry({
            policy: task.retry,
            failedAttempt: attempts,
            retryable: outcome.error?.retryable ?? false,
          });
          if (decision.shouldRetry && attempts <= task.retry.maxRetries) {
            this.metrics.recordRetry();
            this.emit(taskRetryingEvent, {
              coordinationId: plan.coordinationId,
              taskId: task.taskId,
              agentId: task.agentId,
              reasonCode: outcome.error?.code,
            });
            await waitForBackoff(decision.delayMs, request.cancellation);
            continue;
          }
          if (isTimeoutOutcome(outcome)) {
            this.metrics.recordTimeout();
            if (isNonTerminal(state.statusOf(task.taskId))) {
              state.recordResult(
                toTaskResult(task, outcome, startedAt, TaskStatus.TimedOut),
                this.now(),
              );
            }
            this.emit(taskTimedOutEvent, {
              coordinationId: plan.coordinationId,
              taskId: task.taskId,
              agentId: task.agentId,
              reasonCode: outcome.error?.code,
            });
          } else {
            if (isNonTerminal(state.statusOf(task.taskId))) {
              state.recordResult(
                toTaskResult(task, outcome, startedAt, TaskStatus.Failed),
                this.now(),
              );
            }
            this.emit(taskFailedEvent, {
              coordinationId: plan.coordinationId,
              taskId: task.taskId,
              agentId: task.agentId,
              reasonCode: outcome.error?.code,
            });
          }
          this.applyFailurePolicy(plan, state, graph, task.taskId);
          return;
        }
      } catch (error) {
        if (state.isCancelled || error instanceof CoordinationCancelledError) {
          state.forceCancelTask(task.taskId);
          this.emit(taskCancelledEvent, {
            coordinationId: plan.coordinationId,
            taskId: task.taskId,
            agentId: task.agentId,
          });
        } else {
          const startedAt = this.now();
          state.recordResult(
            toTaskResult(
              task,
              normalizedFailure(asError(error), startedAt),
              startedAt,
              TaskStatus.Failed,
            ),
            this.now(),
          );
          this.emit(taskFailedEvent, {
            coordinationId: plan.coordinationId,
            taskId: task.taskId,
            agentId: task.agentId,
            reasonCode: 'INVOCATION_ERROR',
          });
          this.applyFailurePolicy(plan, state, graph, task.taskId);
        }
      } finally {
        running.delete(task.taskId);
        notify();
      }
    };

    for (;;) {
      if (state.isCancelled || state.isDeadlineReached) {
        break;
      }
      const statuses = state.statusByTaskId();
      const ready = graph.readyTasks(statuses);
      const runningByAgent = new Map<string, number>();
      for (const runningTask of running.values()) {
        runningByAgent.set(runningTask.agentId, (runningByAgent.get(runningTask.agentId) ?? 0) + 1);
      }

      const budget = plan.limits.maxConcurrentTasks - running.size;
      const runnable: (typeof plan.tasks)[number][] = [];
      if (budget > 0) {
        for (const task of ready) {
          if (runnable.length >= budget) {
            break;
          }
          const perAgent = runningByAgent.get(task.agentId) ?? 0;
          if (perAgent >= plan.limits.maxTasksPerAgent) {
            continue;
          }
          runnable.push(task);
        }
        runnable.sort((a, b) => b.priority - a.priority || order(plan, a) - order(plan, b));
      }

      for (const task of runnable) {
        if (running.size >= plan.limits.maxConcurrentTasks) {
          break;
        }
        running.set(task.taskId, { taskId: task.taskId, agentId: task.agentId });
        this.emit(agentSelectedEvent, {
          coordinationId: plan.coordinationId,
          taskId: task.taskId,
          agentId: task.agentId,
        });
        void startTask(task);
      }

      if (running.size === 0) {
        const pending = plan.tasks.some((task) => isNonTerminal(state.statusOf(task.taskId)));
        if (!pending) {
          break;
        }
        graph.assertNoDeadlock(statuses);
        break;
      }

      await waitForSettled();
    }
  }

  private recordTask(
    plan: CoordinationPlan,
    state: CoordinationStateStore,
    task: AgentTaskLike,
    outcome: InvocationOutcome,
    startedAt: IsoTimestamp,
    status: TaskStatus,
  ): void {
    const currentStatus = state.statusOf(task.taskId);
    if (!isNonTerminal(currentStatus)) {
      return;
    }
    if (status === TaskStatus.Completed) {
      state.recordResult(toTaskResult(task, outcome, startedAt, TaskStatus.Completed), this.now());
      this.emit(taskCompletedEvent, {
        coordinationId: plan.coordinationId,
        taskId: task.taskId,
        agentId: task.agentId,
      });
    }
  }

  private applyFailurePolicy(
    plan: CoordinationPlan,
    state: CoordinationStateStore,
    graph: TaskDependencyGraph,
    taskId: string,
  ): void {
    const skipsDependents =
      plan.failurePolicy === TaskFailurePolicy.SkipDependents ||
      plan.failurePolicy === TaskFailurePolicy.ContinueIndependent;
    if (skipsDependents) {
      for (const dependent of graph.dependentClosure(taskId)) {
        const status = state.statusOf(dependent);
        if (isNonTerminal(status)) {
          state.skipTask(dependent, status);
        }
      }
    }
    if (plan.failurePolicy === TaskFailurePolicy.FailFast) {
      for (const task of plan.tasks) {
        const status = state.statusOf(task.taskId);
        if (status === TaskStatus.Pending || status === TaskStatus.Ready) {
          state.cancelTask(task.taskId, status);
        }
      }
    }
  }

  private async cancelOutstanding(
    state: CoordinationStateStore,
    plan: CoordinationPlan,
  ): Promise<void> {
    for (const task of plan.tasks) {
      const status = state.statusOf(task.taskId);
      if (status === TaskStatus.Running) {
        state.forceCancelTask(task.taskId);
        // Best-effort executor cancellation (bounded; never awaited on purpose).
        const attempt = this.attemptsByKey.get(attemptKey(plan.coordinationId, task.taskId)) ?? 1;
        void this.invocation.cancel(task, attempt).catch(() => undefined);
      } else if (status === TaskStatus.Pending || status === TaskStatus.Ready) {
        state.cancelTask(task.taskId, status);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Finalization
  // -------------------------------------------------------------------------

  private complete(
    plan: CoordinationPlan,
    state: CoordinationStateStore,
    startedAt: IsoTimestamp,
    correlationId: string,
  ): CoordinationResult {
    const results = Object.values(state.resultByTaskId());
    const conflicts = detectConflicts({ plan, results, statusByTaskId: state.statusByTaskId() });
    for (const conflict of conflicts) {
      state.submitConflict(conflict);
      this.metrics.recordConflict();
      this.emit(conflictDetectedEvent, {
        coordinationId: plan.coordinationId,
        reasonCode: conflict.type,
      });
    }
    const resolution = resolveConflicts(plan, state.conflictsOf, results);
    throwIfConflictsFail(resolution);
    const aggregate = aggregateResults(plan, results, resolution, state.conflictsOf);
    state.markConflictsResolved(resolution.decision === 'continue');

    let status = CoordinationStatus.Completed;
    const failures = results.filter((r) => r.status === TaskStatus.Failed);
    const skips = results.filter((r) => r.status === TaskStatus.Skipped);
    const timeouts = results.filter(
      (r) => r.status === TaskStatus.TimedOut || r.status === TaskStatus.Cancelled,
    );
    if (failures.length > 0) {
      status =
        plan.failurePolicy === TaskFailurePolicy.FailFast ||
        plan.failurePolicy === TaskFailurePolicy.RequireAll
          ? CoordinationStatus.Failed
          : CoordinationStatus.Partial;
    } else if (skips.length > 0 || timeouts.length > 0) {
      status = CoordinationStatus.Partial;
    } else if (aggregate.mustReview) {
      status = CoordinationStatus.Partial;
    }

    state.markComplete(this.now());
    this.emit(coordinationCompletedEvent, {
      coordinationId: plan.coordinationId,
      status: String(status),
      phase: CoordinationPhase.Completed,
    });

    return buildResult({
      coordinationId: plan.coordinationId,
      correlationId,
      status,
      mode: plan.mode,
      plan,
      tasks: results,
      aggregate,
      conflicts: state.conflictsOf,
      startedAt,
      completedAt: this.now(),
    });
  }

  private finalize(
    plan: CoordinationPlan,
    state: CoordinationStateStore,
    startedAt: IsoTimestamp,
    correlationId: string,
    status: CoordinationStatus,
    error: unknown,
    cancelled?: boolean,
    timedOut?: boolean,
  ): CoordinationResult {
    const normalized = toExternalError(error);
    if (status === CoordinationStatus.Cancelled) {
      this.emit(coordinationCancelledEvent, {
        coordinationId: plan.coordinationId,
        reasonCode: normalized?.code,
      });
    } else {
      state.markFailed(this.now());
      this.emit(coordinationFailedEvent, {
        coordinationId: plan.coordinationId,
        reasonCode: timedOut === true ? 'COORDINATION_TIMEOUT' : normalized?.code,
      });
    }
    const results = Object.values(state.resultByTaskId());
    return buildResult({
      coordinationId: plan.coordinationId,
      correlationId,
      status,
      mode: plan.mode,
      plan,
      tasks: results,
      conflicts: state.conflictsOf,
      startedAt,
      completedAt: this.now(),
      cancelled,
      timedOut,
      error: normalized,
    });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private emit(
    type: (input: CoordinationEventInput) => CoordinationEvent,
    input: Partial<CoordinationEventInput>,
  ): void {
    if (this.eventLog === undefined) {
      return;
    }
    try {
      this.eventLog.append(type({ ...input, occurredAt: this.now() }));
    } catch {
      // Observability must never break coordination.
    }
  }
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

type AgentTaskLike = {
  taskId: string;
  agentId: string;
  coordinationId: string;
  timeoutMs: number;
  retry: { maxRetries: number; retryable: boolean };
  input: Readonly<Record<string, unknown>>;
  objective: string;
};

function order(plan: CoordinationPlan, task: { taskId: string }): number {
  return plan.tasks.findIndex((t) => t.taskId === task.taskId);
}

function toTaskResult(
  task: AgentTaskLike,
  outcome: InvocationOutcome,
  startedAt: IsoTimestamp,
  status: TaskStatus,
): TaskResult {
  return Object.freeze({
    taskId: task.taskId,
    agentId: task.agentId,
    status,
    output: outcome.success ? outcome.output : undefined,
    errors: outcome.error
      ? [
          Object.freeze({
            code: outcome.error.code,
            message: outcome.error.message,
            retryable: outcome.error.retryable,
          }),
        ]
      : [],
    timing: Object.freeze({
      startedAt,
      completedAt: outcome.completedAt ?? startedAt,
      durationMs: outcome.durationMs,
    }),
  });
}

function isTimeoutOutcome(outcome: InvocationOutcome): boolean {
  const code = outcome.error?.code ?? '';
  return code.includes('TIMEOUT') || code.includes('TIMED_OUT');
}

function normalizedFailure(error: Error, at: IsoTimestamp): InvocationOutcome {
  return {
    success: false,
    error: {
      code: (error as { code?: string }).code ?? 'COORDINATION_INVOCATION_FAILED',
      message: error.message,
      retryable: true,
    },
    startedAt: at,
    completedAt: at,
    durationMs: 0,
  };
}

function toExternalError(
  error: unknown,
): { code: string; message: string; retryable: boolean } | undefined {
  if (error === undefined) {
    return undefined;
  }
  if (error instanceof Error) {
    return {
      code: (error as { code?: string }).code ?? 'COORDINATION_FAILED',
      message: error.message,
      retryable: (error as { retryable?: boolean }).retryable ?? false,
    };
  }
  return { code: 'COORDINATION_FAILED', message: 'coordination failed', retryable: false };
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === 'string' ? error : 'coordination invocation failure');
}

function buildResult(input: {
  readonly coordinationId: string;
  readonly correlationId: string;
  readonly status: CoordinationStatus;
  readonly mode: CoordinationResult['mode'];
  readonly plan: CoordinationPlan;
  readonly tasks: readonly TaskResult[];
  readonly conflicts: CoordinationAggregate['conflicts'];
  readonly aggregate?: CoordinationAggregate;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly cancelled?: boolean;
  readonly timedOut?: boolean;
  readonly error?: { code: string; message: string; retryable: boolean };
}): CoordinationResult {
  return Object.freeze({
    coordinationId: input.coordinationId,
    correlationId: input.correlationId,
    status: input.status,
    mode: input.mode,
    plan: input.plan,
    tasks: input.tasks,
    aggregate: input.aggregate,
    conflicts: input.conflicts,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: durationMsSince(input.startedAt, input.completedAt),
    cancelled: input.cancelled,
    timedOut: input.timedOut,
    error: input.error,
  });
}

function durationMsSince(startedAt: IsoTimestamp, completedAt: IsoTimestamp): number {
  return Math.max(0, Math.round(Date.parse(completedAt) - Date.parse(startedAt)));
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function attemptKey(coordinationId: string, taskId: string): string {
  return `${coordinationId}:${taskId}`;
}

function attachAbortHandlers(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (signal === undefined) {
    return () => undefined;
  }
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  const listener = (): void => onAbort();
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

function isNonTerminal(status: TaskStatus): boolean {
  return (
    status !== TaskStatus.Completed &&
    status !== TaskStatus.Failed &&
    status !== TaskStatus.Cancelled &&
    status !== TaskStatus.Skipped &&
    status !== TaskStatus.TimedOut
  );
}

function resultIsPostHocTerminal(result: CoordinationResult): 'success' | 'failed' | 'cancelled' {
  switch (result.status) {
    case CoordinationStatus.Cancelled:
      return 'cancelled';
    case CoordinationStatus.Failed:
      return 'failed';
    default:
      return 'success';
  }
}

export type {
  CoordinationEvent,
  CoordinationAggregate,
  CoordinationPlan,
  TaskResult,
  CoordinationPhase,
};
