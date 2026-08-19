import type { Logger } from 'pino';

import { createOrchestratorLogger } from '../../utils/logger.js';
import { ExecutionMode } from '../../routing/types/index.js';
import type { ExecutionEngineContract } from '../interfaces/index.js';
import type { ExecutorRegistry, ConditionEvaluator } from '../interfaces/index.js';
import { ExecutionConcurrencyError } from '../errors/index.js';
import { UnsupportedExecutionModeError } from '../../planning/errors/index.js';
import {
  ExecutionConfigSchema,
  parseExecutionConfig,
  executionConfig,
  isExecutionFeatureEnabled,
  type ExecutionConfig,
} from '../config/index.js';
import { DeterministicConditionEvaluator } from '../conditions/index.js';
import { InMemoryExecutionEventEmitter } from '../events/index.js';
import { CancellationController } from '../cancellation/index.js';
import { ExecutionStateManager } from '../state/index.js';
import { ExecutionResultStore } from '../results/index.js';
import { ExecutionLifecycle, toExecutionError } from '../lifecycle/index.js';
import { resolveExecutionStrategy } from '../strategies/index.js';
import { validateExecutionPlan, validateExecutionRequest } from '../validators/index.js';
import { createDeadline } from '../timeout/index.js';
import { ConcurrencyLimiter } from '../concurrency/index.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionRun,
  ExecutionState,
  ExecutionStepResult,
} from '../types/index.js';
import {
  ExecutionState as ExecutionStateValue,
  ExecutionEventType as ExecutionEventTypeValue,
} from '../types/index.js';
import type { ExecutionEventType } from '../types/index.js';
import type {
  ExecutionPlan,
  ExecutionCondition,
  ExecutionStep,
} from '../../planning/types/index.js';

/** Options for constructing the execution engine. */
export interface ExecutionEngineOptions {
  readonly config?: ExecutionConfig;
  readonly registry?: ExecutorRegistry;
  readonly conditionEvaluator?: ConditionEvaluator;
  readonly events?: InMemoryExecutionEventEmitter;
  readonly logger?: Logger;
}

/** The controlled execution engine (Sprint 6, prompt §4). */
export class ExecutionEngine implements ExecutionEngineContract {
  readonly name = 'execution-engine';
  readonly version = '1.0.0';

  private readonly config: ExecutionConfig;
  private readonly registry: ExecutorRegistry;
  private readonly conditionEvaluator: ConditionEvaluator;
  private readonly logger: Logger;
  private readonly active = new Map<string, CancellationController>();

  constructor(options: ExecutionEngineOptions = {}) {
    this.config = options.config ?? executionConfig;
    this.registry = options.registry ?? { resolve: () => undefined };
    this.conditionEvaluator = options.conditionEvaluator ?? new DeterministicConditionEvaluator();
    this.logger = options.logger ?? createOrchestratorLogger('execution');
  }

  /** Cancels a running execution. Idempotent (prompt §14). */
  cancel(executionId: string, reason = 'cancelled by caller'): void {
    if (!isExecutionFeatureEnabled(this.config, 'cancellation')) {
      return;
    }
    this.active.get(executionId)?.cancel(reason);
  }

  /** Executes a validated execution plan (prompt §4). */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    validateExecutionRequest(request);
    validateExecutionPlan(request.plan);

    if (
      isExecutionFeatureEnabled(this.config, 'idempotency') &&
      this.active.has(request.executionId)
    ) {
      throw new ExecutionConcurrencyError(
        `Execution ${request.executionId} is already running; refusing duplicate scheduling`,
        { details: { executionId: request.executionId } },
      );
    }

    const cancellation = new CancellationController();
    const stateManager = new ExecutionStateManager();
    const resultStore = new ExecutionResultStore();
    const events = new InMemoryExecutionEventEmitter();
    this.active.set(request.executionId, cancellation);

    const run = this.createRun(request);
    const lifecycle = new ExecutionLifecycle({
      run,
      config: this.config,
      registry: this.registry,
      conditionEvaluator: this.planConditionEvaluator(request.plan),
      events,
      cancellation,
      stateManager,
      resultStore,
      logger: this.logger,
    }).withInputs(request.inputs ?? {});

    const emit = (
      type: ExecutionEventType,
      extra: {
        stepId?: string;
        agentId?: string;
        errorCode?: string;
        metadata?: Readonly<Record<string, unknown>>;
      } = {},
    ): void => {
      if (!this.config.EXECUTION_EVENTS_ENABLED) {
        return;
      }
      events.emit({
        type,
        executionId: request.executionId,
        planId: request.plan.planId,
        stepId: extra.stepId,
        agentId: extra.agentId,
        errorCode: extra.errorCode,
        metadata: extra.metadata,
        occurredAt: new Date().toISOString(),
      });
    };

    const startedAt = new Date().toISOString();
    emit(ExecutionEventTypeValue.ExecutionCreated);
    stateManager.transition(ExecutionStateValue.Ready);
    emit(ExecutionEventTypeValue.ExecutionStarted);

    let finalState: ExecutionState;
    let overallTimeout: number | undefined;
    let cancellationReason: string | undefined;
    let terminalError:
      | {
          readonly code: string;
          readonly message: string;
          readonly retryable: boolean;
          readonly details?: Readonly<Record<string, unknown>>;
        }
      | undefined;

    try {
      this.assertModeEnabled(request.plan.mode);
      const strategy = resolveExecutionStrategy(request.plan.mode);
      const deadlineMs = this.overallTimeoutMs(request.plan);
      const deadlineStartedAt = Date.now();
      const deadline = createDeadline(deadlineMs);

      try {
        const work = this.runStrategy(strategy, lifecycle, stateManager);

        const race: Promise<'done' | 'timeout' | 'cancelled'>[] = [
          work.then(() => 'done' as const),
          deadline.promise.then(() => 'timeout' as const),
        ];

        if (isExecutionFeatureEnabled(this.config, 'cancellation')) {
          race.push(cancellation.waitForCancellation().then(() => 'cancelled' as const));
        }

        let settled: 'done' | 'timeout' | 'cancelled' = await Promise.race(race);

        // Authoritative deadline enforcement (C-2): a race won by the work
        // promise must not outlive the overall deadline. If the deadline has
        // actually elapsed, treat the run as timed out even though the race
        // settled first (timer ordering under load is not reliable).
        if (settled === 'done' && Date.now() - deadlineStartedAt >= deadlineMs) {
          settled = 'timeout';
        }

        if (settled === 'timeout') {
          overallTimeout = deadlineMs;
          cancellation.cancel('overall execution timeout exceeded');
        }

        if (settled === 'cancelled') {
          cancellationReason = cancellation.cancellationReason ?? 'cancelled';
          lifecycle.cancellation.cancel(cancellationReason);
        }

        await work.catch(() => undefined);

        finalState = this.computeFinalState(
          stateManager,
          settled,
          cancellationReason,
          overallTimeout,
        );
      } finally {
        deadline.clear();
      }
    } catch (error) {
      finalState = stateManager.settle(ExecutionStateValue.Failed);
      const structured = toExecutionError(error);
      terminalError = structured;
    }

    const completedAt = new Date().toISOString();
    const stepResults = this.collectStepResults(request.plan, lifecycle, finalState);
    const durationMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
    const retryCount = lifecycle.retryLog.length;

    if (cancellationReason !== undefined) {
      emit(ExecutionEventTypeValue.ExecutionCancelled, {
        errorCode: terminalError?.code,
      });
    } else if (finalState === ExecutionStateValue.TimedOut) {
      emit(ExecutionEventTypeValue.ExecutionTimedOut, {
        errorCode: 'EXECUTION_TIMEOUT_ERROR',
      });
    } else if (finalState === ExecutionStateValue.Failed) {
      emit(ExecutionEventTypeValue.ExecutionFailed, {
        errorCode: terminalError?.code ?? 'EXECUTION_FAILED',
      });
    } else {
      emit(ExecutionEventTypeValue.ExecutionCompleted);
    }

    const metrics = resultStore.metrics(
      request.executionId,
      request.plan.planId,
      request.plan.steps.length,
      startedAt,
      completedAt,
      retryCount,
      this.parallelBranches(request.plan),
      finalState,
    );

    this.logger.info(
      {
        executionId: request.executionId,
        planId: request.plan.planId,
        executionMode: request.plan.mode,
        stepCount: request.plan.steps.length,
        retryCount,
        durationMs,
        status: finalState,
      },
      'execution finished',
    );

    this.active.delete(request.executionId);

    return {
      executionId: request.executionId,
      planId: request.plan.planId,
      requestId: request.requestId,
      traceId: request.traceId,
      state: finalState,
      startedAt,
      completedAt,
      durationMs,
      stepResults,
      events: events.all(),
      metrics,
      cancellation:
        cancellationReason !== undefined
          ? {
              executionId: request.executionId,
              reason: cancellationReason,
              requestedAt: completedAt,
            }
          : undefined,
      timeout:
        overallTimeout !== undefined
          ? {
              executionId: request.executionId,
              timeoutMs: overallTimeout,
              occurredAt: completedAt,
            }
          : undefined,
      error: terminalError,
    };
  }

  /** Builds a plan-aware evaluator so composite conditions resolve children. */
  private planConditionEvaluator(plan: ExecutionPlan): ConditionEvaluator {
    if (this.conditionEvaluator instanceof DeterministicConditionEvaluator) {
      return new DeterministicConditionEvaluator(plan.conditions);
    }
    return this.conditionEvaluator;
  }

  private createRun(request: ExecutionRequest): ExecutionRun {
    return {
      executionId: request.executionId,
      plan: request.plan,
      requestId: request.requestId,
      traceId: request.traceId,
      createdAt: new Date().toISOString(),
      state: ExecutionStateValue.Pending,
    };
  }

  private runStrategy(
    strategy: ReturnType<typeof resolveExecutionStrategy>,
    lifecycle: ExecutionLifecycle,
    stateManager: ExecutionStateManager,
  ): Promise<void> {
    stateManager.transition(ExecutionStateValue.Running);

    const limiter = new ConcurrencyLimiter(this.config.EXECUTION_MAX_CONCURRENT_STEPS);

    const input = {
      run: lifecycle.run,
      executeStep: async (step: ExecutionStep) => {
        await limiter.run(async () => {
          if (lifecycle.cancellation.isCancelled) {
            return;
          }
          await lifecycle.executeStep(step);
        });
      },
      evaluateCondition: (condition: ExecutionCondition) =>
        lifecycle.evaluateCondition(condition, {}),
      isCancelled: () => lifecycle.cancellation.isCancelled,
      stopRequested: () => lifecycle.stopRequested,
      shouldSkipStep: (step: ExecutionStep) => this.stepShouldSkip(lifecycle, step),
    };

    return Promise.resolve(strategy.execute(input)).then(() => undefined);
  }

  /** Whether a conditional step should be skipped (prompt §8). */
  private stepShouldSkip(lifecycle: ExecutionLifecycle, step: ExecutionStep): boolean {
    const plan = lifecycle.run.plan;
    if (plan.mode !== ExecutionMode.Conditional) {
      return false;
    }

    const branch = plan.branches.find((candidate) => candidate.stepIds.includes(step.stepId));
    if (branch === undefined) {
      return false;
    }

    return !lifecycle.evaluateCondition(branch.condition, this.conditionInputs(lifecycle, plan));
  }

  /** Builds the conditional evaluation store from inputs + step outputs. */
  private conditionInputs(
    lifecycle: ExecutionLifecycle,
    plan: ExecutionPlan,
  ): Readonly<Record<string, unknown>> {
    const store: Record<string, unknown> = {};
    for (const step of plan.steps) {
      const output = lifecycle.resultStore.output(step.stepId);
      if (output !== undefined) {
        store[`${step.stepId}.output`] = output;
      }
    }
    return store;
  }

  private computeFinalState(
    stateManager: ExecutionStateManager,
    settled: 'done' | 'timeout' | 'cancelled',
    cancellationReason: string | undefined,
    overallTimeout: number | undefined,
  ): ExecutionState {
    const results = stateManager.snapshot;
    const stepStatuses = [...results.values()].map((step) => step.status);
    const timedOutCount = stepStatuses.filter((status) => status === 'TimedOut').length;
    const failureCount = stepStatuses.filter(
      (status) => status === 'Failed' || status === 'TimedOut',
    ).length;
    const successCount = stepStatuses.filter((status) => status === 'Succeeded').length;
    const cancelledCount = stepStatuses.filter((status) => status === 'Cancelled').length;

    if (cancellationReason !== undefined || settled === 'cancelled') {
      return stateManager.settle(ExecutionStateValue.Cancelled);
    }
    if (overallTimeout !== undefined || settled === 'timeout') {
      return stateManager.settle(ExecutionStateValue.TimedOut);
    }
    if (timedOutCount > 0) {
      return stateManager.settle(ExecutionStateValue.TimedOut);
    }
    // All steps cancelled with none completed must not fall back to Completed.
    if (cancelledCount > 0 && successCount === 0 && failureCount === 0) {
      return stateManager.settle(ExecutionStateValue.Cancelled);
    }
    if (failureCount > 0) {
      return stateManager.settle(
        successCount > 0 ? ExecutionStateValue.Partial : ExecutionStateValue.Failed,
      );
    }
    return stateManager.settle(ExecutionStateValue.Completed);
  }

  private collectStepResults(
    plan: ExecutionPlan,
    lifecycle: ExecutionLifecycle,
    finalState: ExecutionState,
  ): readonly ExecutionStepResult[] {
    const results = lifecycle.resultStore.all();
    if (results.length === plan.steps.length) {
      return results;
    }

    const missing = plan.steps.filter(
      (step) => !results.some((result) => result.stepId === step.stepId),
    );

    for (const step of missing) {
      lifecycle.skipStep(
        step,
        finalState === ExecutionStateValue.Cancelled || finalState === ExecutionStateValue.TimedOut
          ? 'not-started'
          : 'skipped',
      );
    }

    return lifecycle.resultStore.all();
  }

  private overallTimeoutMs(plan: ExecutionPlan): number {
    const budget = plan.policy.maxTotalExecutionTimeMs || this.config.EXECUTION_DEFAULT_TIMEOUT_MS;
    return Math.min(budget, this.config.EXECUTION_MAX_TIMEOUT_MS);
  }

  /** Fails closed when a strategy-requiring feature flag is disabled (H-5). */
  private assertModeEnabled(mode: ExecutionMode): void {
    if (
      (mode === ExecutionMode.Parallel || mode === ExecutionMode.Hybrid) &&
      !isExecutionFeatureEnabled(this.config, 'parallel')
    ) {
      throw new UnsupportedExecutionModeError(
        `Parallel execution is disabled by configuration (mode: ${mode})`,
      );
    }
    if (
      mode === ExecutionMode.Conditional &&
      !isExecutionFeatureEnabled(this.config, 'conditional')
    ) {
      throw new UnsupportedExecutionModeError(
        `Conditional execution is disabled by configuration (mode: ${mode})`,
      );
    }
  }

  private parallelBranches(plan: ExecutionPlan): number {
    if (plan.mode === ExecutionMode.Parallel) {
      return Math.min(plan.steps.length, this.config.EXECUTION_MAX_CONCURRENT_STEPS);
    }
    if (plan.mode === ExecutionMode.Hybrid) {
      return Math.max(
        1,
        Math.min(plan.steps.length - 1, this.config.EXECUTION_MAX_CONCURRENT_STEPS),
      );
    }
    return 1;
  }
}

export { ExecutionConfigSchema, parseExecutionConfig, isExecutionFeatureEnabled };
