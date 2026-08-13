import type { Logger } from 'pino';

import { createOrchestratorLogger } from '../../utils/logger.js';
import type { ExecutionStatus } from '../../types/index.js';
import { ExecutionStatus as ExecutionStatusValue } from '../../types/index.js';
import type { AgentExecutor, ExecutorRegistry, ConditionEvaluator } from '../interfaces/index.js';
import type { AgentExecutionRequest } from '../interfaces/executor.js';
import {
  AgentExecutorError,
  ExecutionCancelledError,
  ExecutionInputResolutionError,
  ExecutionTimeoutError,
} from '../errors/index.js';
import type { ExecutionConfig } from '../config/index.js';
import { CancellationController } from '../cancellation/index.js';
import { ExecutionStateManager } from '../state/index.js';
import { ExecutionResultStore } from '../results/index.js';
import { InMemoryExecutionEventEmitter } from '../events/index.js';
import { computeRetryDelay, effectiveMaxAttempts, shouldRetry } from '../retry/index.js';
import { withTimeout } from '../timeout/index.js';
import type { ExecutionRun } from '../types/index.js';
import type {
  ExecutionError,
  ExecutionEventType,
  ExecutionReference,
  ExecutionRetry,
  ExecutionStepResult,
} from '../types/index.js';
import { ExecutionEventType as ExecutionEventTypeValue } from '../types/index.js';
import type { ExecutionStep, FailurePolicy } from '../../planning/types/index.js';
import { FailurePolicy as FailurePolicyValue } from '../../planning/types/index.js';

type ResolvedInput = Readonly<Record<string, unknown>>;

/**
 * Coordinates single-step execution for the engine: resolves inputs, applies
 * retry/timeout/cancellation, honours failure policies, records results and
 * emits events. Owns the run's cancellation controller and result store.
 * All state is execution-local; nothing is persisted (prompt §11/§18).
 */
export class ExecutionLifecycle {
  readonly run: ExecutionRun;
  readonly stateManager: ExecutionStateManager;
  readonly resultStore: ExecutionResultStore;
  readonly events: InMemoryExecutionEventEmitter;
  readonly cancellation: CancellationController;
  readonly retryLog: readonly ExecutionRetry[];

  private readonly retryLogInternal: ExecutionRetry[] = [];
  private readonly config: ExecutionConfig;
  private readonly registry: ExecutorRegistry;
  private readonly conditionEvaluator: ConditionEvaluator;
  private readonly logger: Logger;
  private readonly executedSteps = new Set<string>();
  private stopFlag = false;
  private failurePolicyStop = false;
  private runInputs: Readonly<Record<string, unknown>> = {};

  constructor(options: {
    readonly run: ExecutionRun;
    readonly config: ExecutionConfig;
    readonly registry: ExecutorRegistry;
    readonly conditionEvaluator: ConditionEvaluator;
    readonly events?: InMemoryExecutionEventEmitter;
    readonly logger?: Logger;
    readonly cancellation?: CancellationController;
    readonly stateManager?: ExecutionStateManager;
    readonly resultStore?: ExecutionResultStore;
  }) {
    this.run = options.run;
    this.config = options.config;
    this.registry = options.registry;
    this.conditionEvaluator = options.conditionEvaluator;
    this.events = options.events ?? new InMemoryExecutionEventEmitter();
    this.cancellation = options.cancellation ?? new CancellationController();
    this.stateManager = options.stateManager ?? new ExecutionStateManager();
    this.resultStore = options.resultStore ?? new ExecutionResultStore();
    this.logger = options.logger ?? createOrchestratorLogger('execution');
    this.retryLog = this.retryLogInternal;
    this.logger.debug({ executionId: this.run.executionId }, 'execution lifecycle ready');
  }

  get isCancelled(): boolean {
    return this.cancellation.isCancelled;
  }

  get stopRequested(): boolean {
    return this.stopFlag || this.failurePolicyStop || this.cancellation.isCancelled;
  }

  /** Records the execution-local input store used for reference resolution. */
  withInputs(inputs: Readonly<Record<string, unknown>>): this {
    this.runInputs = inputs;
    return this;
  }

  /** Emits a typed event if event emission is enabled (prompt §16/§17). */
  private emit(
    type: ExecutionEventType,
    extra: {
      stepId?: string;
      agentId?: string;
      attempt?: number;
      errorCode?: string;
      metadata?: Readonly<Record<string, unknown>>;
    },
  ): void {
    if (!this.config.EXECUTION_EVENTS_ENABLED) {
      return;
    }
    this.events.emit({
      type,
      executionId: this.run.executionId,
      planId: this.run.plan.planId,
      stepId: extra.stepId,
      agentId: extra.agentId,
      attempt: extra.attempt,
      errorCode: extra.errorCode,
      metadata: extra.metadata,
      occurredAt: new Date().toISOString(),
    });
  }

  /** Resolves a reference from the execution-local store (prompt §10). */
  resolveFromStore(
    reference: ExecutionReference,
    inputs: Readonly<Record<string, unknown>>,
  ): unknown | undefined {
    if (reference.type === 'step') {
      return this.outputByStepId(reference.id);
    }
    const value = inputs[reference.id];
    if (value !== undefined) {
      return value;
    }
    return this.runInputs[reference.id];
  }

  /** Evaluates a declarative condition against the resolved input store. */
  evaluateCondition(
    condition: Parameters<ConditionEvaluator['evaluate']>[0],
    inputs: Readonly<Record<string, unknown>>,
  ): boolean {
    return this.conditionEvaluator.evaluate(condition, {
      resolve: (field) => {
        if (inputs[field] !== undefined) {
          return inputs[field];
        }
        return this.runInputs[field];
      },
    });
  }

  /** Retrieves the output of an earlier completed step. */
  private outputByStepId(referenceId: string): unknown {
    const match = /^([\w-]+)\.output$/.exec(referenceId);
    if (match === null) {
      return undefined;
    }
    const result = this.resultStore.get(match[1]!);
    return result?.output;
  }

  /** Skips a step (e.g. conditional branch not satisfied or cancelled). */
  skipStep(step: ExecutionStep, reason: string): ExecutionStepResult {
    const skipped = this.skippedResult(step, reason);
    this.executedSteps.add(step.stepId);
    this.resultStore.record(step.stepId, skipped);
    this.emit(ExecutionEventTypeValue.StepSkipped, {
      stepId: step.stepId,
      agentId: step.agentId,
      metadata: { reason },
    });
    return skipped;
  }

  /** Executes a single step honouring retry, timeout and cancellation. */
  async executeStep(
    step: ExecutionStep,
    inputs: Readonly<Record<string, unknown>> = {},
  ): Promise<ExecutionStepResult> {
    const existing = this.resultStore.get(step.stepId);
    if (existing !== undefined || this.executedSteps.has(step.stepId)) {
      return existing ?? this.skippedResult(step, 'already-executed');
    }

    if (this.cancellation.isCancelled) {
      return this.skipStep(step, 'cancelled');
    }

    const executor = this.registry.resolve(step.agentId);
    if (executor === undefined) {
      return this.failStep(
        step,
        {
          code: 'AGENT_EXECUTOR_UNAVAILABLE',
          message: `No executor available for agent ${step.agentId}`,
          retryable: false,
        },
        { attempts: 1 },
      );
    }

    const startedAt = new Date().toISOString();
    this.stateManager.startStep(step, startedAt);
    this.emit(ExecutionEventTypeValue.StepStarted, {
      stepId: step.stepId,
      agentId: step.agentId,
      attempt: 1,
    });

    let resolvedInputs: ResolvedInput;
    try {
      resolvedInputs = this.resolveStepInputs(step, inputs);
    } catch (error) {
      return this.failStep(step, toExecutionError(error), { attempts: 1 });
    }

    const maxAttempts = effectiveMaxAttempts(step.retry, this.config);
    let lastError: ExecutionError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.cancellation.isCancelled) {
        return this.cancelStep(step);
      }

      const attemptStartedAt = new Date().toISOString();
      const request: AgentExecutionRequest = {
        executionId: this.run.executionId,
        stepId: step.stepId,
        agentId: step.agentId,
        inputs: resolvedInputs,
        policy: step.policy,
        traceId: this.run.traceId,
      };

      let agentResult: Awaited<ReturnType<AgentExecutor['execute']>> | undefined;
      try {
        agentResult = await this.executeWithGuards(step, request);
      } catch (error) {
        lastError = toExecutionError(error);
      }

      if (agentResult !== undefined && agentResult.success) {
        const result: ExecutionStepResult = {
          stepId: step.stepId,
          agentId: step.agentId,
          order: step.order,
          status: ExecutionStatusValue.Succeeded,
          attemptCount: attempt,
          startedAt: attemptStartedAt,
          completedAt: agentResult.completedAt,
          durationMs: agentResult.durationMs,
          output: agentResult.output,
          metadata: agentResult.metadata,
        };

        this.executedSteps.add(step.stepId);
        this.resultStore.record(step.stepId, result);
        this.stateManager.finishStep(
          step.stepId,
          step.agentId,
          ExecutionStatusValue.Succeeded,
          agentResult.completedAt,
        );
        this.emit(ExecutionEventTypeValue.StepCompleted, {
          stepId: step.stepId,
          agentId: step.agentId,
          attempt,
        });
        return result;
      }

      if (lastError === undefined) {
        lastError =
          agentResult?.error ??
          ({
            code: 'AGENT_EXECUTION_FAILED',
            message: 'Agent execution failed',
            retryable: true,
          } satisfies ExecutionError);
      }

      if (this.cancellation.isCancelled) {
        return this.cancelStep(step);
      }

      const willRetry = shouldRetry(lastError, attempt, maxAttempts, step.retry.retryable);

      if (willRetry) {
        const delayMs = computeRetryDelay(
          attempt,
          this.config.EXECUTION_BACKOFF_BASE_MS,
          this.config.EXECUTION_BACKOFF_MAX_MS,
        );
        this.stateManager.retryStep(step, attempt + 1);
        this.retryLogInternal.push({
          stepId: step.stepId,
          attempt,
          maxAttempts,
          delayMs,
          error: lastError,
        });
        this.emit(ExecutionEventTypeValue.StepRetrying, {
          stepId: step.stepId,
          agentId: step.agentId,
          attempt: attempt + 1,
          errorCode: lastError.code,
          metadata: { delayMs },
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      const finalError = lastError;
      const status: ExecutionStatus = isTimeoutError(finalError)
        ? ExecutionStatusValue.TimedOut
        : ExecutionStatusValue.Failed;
      return this.failStep(step, finalError, { attempts: attempt, status });
    }

    return this.failStep(
      step,
      lastError ?? {
        code: 'AGENT_EXECUTION_FAILED',
        message: 'Agent execution failed after exhausting retries',
        retryable: false,
      },
      { attempts: maxAttempts },
    );
  }

  private async executeWithGuards(
    step: ExecutionStep,
    request: AgentExecutionRequest,
  ): Promise<Awaited<ReturnType<AgentExecutor['execute']>>> {
    const executor = this.registry.resolve(step.agentId)!;
    const work = Promise.race([
      executor.execute(request),
      this.cancellation.waitForCancellation().then(() => {
        throw this.cancellation.cancellationError();
      }),
    ]);
    return withTimeout(
      work,
      step.timeoutMs,
      `Step ${step.stepId} exceeded timeout of ${step.timeoutMs}ms`,
    );
  }

  private resolveStepInputs(
    step: ExecutionStep,
    extra: Readonly<Record<string, unknown>>,
  ): ResolvedInput {
    const merged = this.mergeInputs(extra);
    const resolved: Record<string, unknown> = {};

    for (const reference of step.input) {
      const value = this.resolveFromStore(reference, merged);
      if (value === undefined && reference.optional !== true) {
        throw new ExecutionInputResolutionError(
          `Cannot resolve required input reference ${reference.id} for step ${step.stepId}`,
          { details: { reference: reference.id, stepId: step.stepId } },
        );
      }
      if (value !== undefined) {
        resolved[reference.id] = value;
      }
    }

    return resolved;
  }

  private mergeInputs(extra: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const merged: Record<string, unknown> = { ...this.runInputs };
    for (const key of Object.keys(extra)) {
      merged[key] = extra[key];
    }
    return merged;
  }

  private skippedResult(step: ExecutionStep, reason: string): ExecutionStepResult {
    const at = new Date().toISOString();
    return {
      stepId: step.stepId,
      agentId: step.agentId,
      order: step.order,
      status: ExecutionStatusValue.Cancelled,
      attemptCount: 0,
      startedAt: at,
      completedAt: at,
      durationMs: 0,
      skipped: true,
      metadata: { reason },
    };
  }

  private cancelStep(step: ExecutionStep): ExecutionStepResult {
    const result = this.skippedResult(step, 'cancelled');
    this.executedSteps.add(step.stepId);
    this.resultStore.record(step.stepId, result);
    this.stateManager.finishStep(
      step.stepId,
      step.agentId,
      ExecutionStatusValue.Cancelled,
      result.completedAt,
    );
    this.emit(ExecutionEventTypeValue.StepCancelled, {
      stepId: step.stepId,
      agentId: step.agentId,
    });
    return result;
  }

  private failStep(
    step: ExecutionStep,
    error: ExecutionError,
    options: { readonly attempts: number; readonly status?: ExecutionStatus } = { attempts: 1 },
  ): ExecutionStepResult {
    const status = options.status ?? ExecutionStatusValue.Failed;
    const at = new Date().toISOString();
    const result: ExecutionStepResult = {
      stepId: step.stepId,
      agentId: step.agentId,
      order: step.order,
      status,
      attemptCount: options.attempts,
      startedAt: at,
      completedAt: at,
      durationMs: 0,
      error,
      metadata: this.failureMetadata(step.policy.failureBehavior),
    };

    this.executedSteps.add(step.stepId);
    this.resultStore.record(step.stepId, result);
    this.stateManager.finishStep(step.stepId, step.agentId, status, at, error);

    const eventType: ExecutionEventType =
      status === ExecutionStatusValue.TimedOut
        ? ExecutionEventTypeValue.StepTimedOut
        : ExecutionEventTypeValue.StepFailed;
    this.emit(eventType, {
      stepId: step.stepId,
      agentId: step.agentId,
      attempt: options.attempts,
      errorCode: error.code,
      metadata: this.failureMetadata(step.policy.failureBehavior),
    });

    if (step.policy.failureBehavior !== FailurePolicyValue.Continue) {
      this.failurePolicyStop = true;
    }

    return result;
  }

  /** Failure metadata attached to results and events (prompt §15). */
  private failureMetadata(policy: FailurePolicy): Readonly<Record<string, unknown>> {
    switch (policy) {
      case FailurePolicyValue.FailFast:
        return { policy: 'FAIL_FAST', directedStop: true };
      case FailurePolicyValue.Continue:
        return { policy: 'CONTINUE', directedStop: false };
      case FailurePolicyValue.Fallback:
        return { policy: 'FALLBACK', fallbackAllowed: true, fallbackAssigned: false };
      case FailurePolicyValue.Escalate:
        return { policy: 'ESCALATE', escalated: true };
      default:
        return { policy: String(policy) };
    }
  }
}

/** Normalises unknown thrown values to a structured ExecutionError. */
export function toExecutionError(error: unknown): ExecutionError {
  if (isExecutionError(error)) {
    return error;
  }
  if (error instanceof ExecutionTimeoutError) {
    return {
      code: 'EXECUTION_TIMEOUT_ERROR',
      message: error.message,
      retryable: false,
      details: error.details,
    };
  }
  if (error instanceof ExecutionCancelledError) {
    return {
      code: 'EXECUTION_CANCELLED_ERROR',
      message: error.message,
      retryable: false,
      details: error.details,
    };
  }
  if (error instanceof AgentExecutorError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  return {
    code: 'EXECUTION_ENGINE_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function isExecutionError(value: unknown): value is ExecutionError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ExecutionError).code === 'string' &&
    typeof (value as ExecutionError).message === 'string'
  );
}

function isTimeoutError(error: ExecutionError): boolean {
  return error.code === 'EXECUTION_TIMEOUT_ERROR';
}
