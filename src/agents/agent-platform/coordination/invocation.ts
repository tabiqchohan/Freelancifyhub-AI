/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Runtime invocation
 * adapter (Sprint 20 §9/§12).
 *
 * The adapter is the ONLY point where the coordinator drives an agent. It
 * always goes through the runtime {@link ExecutorRegistry}, which enforces the
 * Sprint 19 platform gate and lifecycle lease for managed agents — the
 * coordinator deliberately never double-claims a platform slot. The adapter:
 *
 *   - builds a bounded `AgentExecutionRequest` per attempt,
 *   - pins retries to ZERO (retries belong to the coordinator, §16),
 *   - pins the failure behavior to FailFast for the single step,
 *   - forwards cancellation to the executor.
 */

import type { ExecutionPolicy } from '../../ag-001-master-orchestrator/planning/types/index.js';
import { FailurePolicy } from '../../ag-001-master-orchestrator/planning/types/index.js';
import type {
  AgentExecutionRequest,
  ExecutorRegistry,
} from '../../ag-001-master-orchestrator/execution/index.js';
import { CoordinationInvocationError } from './errors.js';
import type { AgentTask, TaskInvocation } from './types.js';

/** Options for the runtime invocation adapter. */
export interface RuntimeAgentInvocationAdapterOptions {
  readonly executorRegistry: ExecutorRegistry;
  readonly executionIdPrefix?: string;
  readonly traceIdFactory?: (coordinationId: string, taskId: string) => string;
}

/** Minimal result shape the coordinator needs from the executor. */
export interface InvocationOutcome {
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: { code: string; message: string; retryable: boolean };
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

/**
 * Drives a single agent invocation through the runtime executor, deriving a
 * deterministic, bounded execution request per attempt.
 */
export class RuntimeAgentInvocationAdapter {
  readonly name = 'coordination-invocation-adapter';

  private readonly executorRegistry: ExecutorRegistry;
  private readonly executionIdPrefix: string;
  private readonly traceIdFactory: (coordinationId: string, taskId: string) => string;

  constructor(options: RuntimeAgentInvocationAdapterOptions) {
    this.executorRegistry = options.executorRegistry;
    this.executionIdPrefix = options.executionIdPrefix ?? 'coord';
    this.traceIdFactory =
      options.traceIdFactory ??
      ((coordinationId, taskId) => `coordination:${coordinationId}:${taskId}`);
  }

  /** Resolves the executor for a task's agent (throws typed rejection). */
  executorFor(task: TaskInvocation) {
    const executor = this.executorRegistry.resolve(task.agentId);
    if (executor === undefined) {
      throw new CoordinationInvocationError(
        `no executor registered for agent ${task.agentId} (task ${task.taskId})`,
        { agentId: task.agentId, taskId: task.taskId },
      );
    }
    return executor;
  }

  /**
   * Builds the `AgentExecutionRequest` for one attempt. The task's configured
   * timeout applies to the whole step; retries are pinned to zero so the
   * coordinator's retry loop (never an executor) owns the backoff.
   */
  buildRequest(task: AgentTask, attempt: number, traceId?: string): AgentExecutionRequest {
    const executionId = `exec_${this.executionIdPrefix}_${task.coordinationId}_${task.taskId.replace(/[^a-zA-Z0-9]/g, '_')}_attempt${attempt}`;
    const policy: ExecutionPolicy = {
      timeoutMs: task.timeoutMs,
      retry: { maxRetries: 0, retryable: true, backoffMs: 0 },
      failureBehavior: FailurePolicy.FailFast,
      continueOnFailure: false,
      stopOnFailure: true,
      fallbackAllowed: false,
      maxSteps: 1,
      maxTotalExecutionTimeMs: task.timeoutMs,
    };
    return {
      executionId,
      stepId: `coord:${task.coordinationId}:${task.taskId}`,
      agentId: task.agentId,
      inputs: sanitizedInputs(task.input),
      policy,
      traceId: traceId ?? this.traceIdFactory(task.coordinationId, task.taskId),
    };
  }

  /**
   * Invokes the target agent through the runtime executor, capturing a safe,
   * normalized outcome. Never throws for agent-level failures — it returns an
   * `InvocationOutcome` with `success: false` and the normalized error.
   */
  async invoke(task: AgentTask, attempt: number): Promise<InvocationOutcome> {
    const executor = this.executorFor(task);
    const request = this.buildRequest(task, attempt);
    try {
      const result = await executor.execute(request);
      return {
        success: result.success,
        output: result.output,
        error: result.error
          ? {
              code: result.error.code,
              message: result.error.message,
              retryable: result.error.retryable,
            }
          : undefined,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
      };
    } catch (error) {
      return {
        success: false,
        error: normalizeFailure(error, task.agentId),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
      };
    }
  }

  /** Best-effort cancellation of a running task execution. */
  async cancel(task: AgentTask, attempt: number): Promise<void> {
    const executor = this.executorFor(task);
    const executionId = this.buildRequest(task, attempt).executionId;
    await executor.cancel(executionId);
  }
}

function sanitizedInputs(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (input === undefined) {
    return {};
  }
  return Object.freeze({ ...input });
}

function normalizeFailure(
  error: unknown,
  agentId: string,
): { code: string; message: string; retryable: boolean } {
  if (error instanceof Error) {
    return {
      code: 'COORDINATION_INVOCATION_FAILED',
      message: error.message,
      retryable: true,
    };
  }
  return {
    code: 'COORDINATION_INVOCATION_FAILED',
    message: `agent ${agentId} threw during invocation`,
    retryable: true,
  };
}
