import type { AgentExecutor, ExecutorRegistry } from '../interfaces/index.js';
import type { AgentExecutionRequest, AgentExecutionResult } from '../interfaces/executor.js';
import type { ExecutionError } from '../types/index.js';

/** Options for the fake executor used in tests (prompt §3/§25). */
export interface FakeExecutorOptions {
  readonly id?: string;
  /** Agent ids this executor claims to support (empty = any agent). */
  readonly supportedAgents?: readonly string[];
  /** Milliseconds of simulated work before the promise resolves. */
  readonly delayMs?: number;
  /** Whether the execution succeeds (default true). */
  readonly succeed?: boolean;
  /** Simulated output returned on success. */
  readonly output?: unknown;
  /** Error returned on failure. */
  readonly error?: ExecutionError;
  /** Succeeds only after this many attempts (for retry tests). */
  readonly succeedAfterAttempts?: number;
  /** Throws/synchronously rejects with this error. */
  readonly throwError?: ExecutionError;
  /** Number of `execute` calls before the executor sticks to success. */
  readonly available?: boolean;
}

/**
 * Deterministic, fake {@link AgentExecutor} for tests. Never talks to real
 * agents, memory, knowledge, tools, LLMs or external services (prompt §3).
 */
export class FakeAgentExecutor implements AgentExecutor {
  readonly id: string;
  private readonly options: FakeExecutorOptions;
  private readonly calls: AgentExecutionRequest[] = [];
  private readonly cancelledExecutions = new Set<string>();

  constructor(options: FakeExecutorOptions = {}) {
    this.options = options;
    this.id = options.id ?? `fake-executor-${Math.random().toString(36).slice(2, 8)}`;
  }

  get available(): boolean {
    return this.options.available ?? true;
  }

  get invocationCount(): number {
    return this.calls.length;
  }

  get callsSnapshot(): readonly AgentExecutionRequest[] {
    return [...this.calls];
  }

  get cancelledSnapshot(): readonly string[] {
    return [...this.cancelledExecutions];
  }

  canExecute(agentId: string): boolean {
    const supported = this.options.supportedAgents;
    if (supported === undefined || supported.length === 0) {
      return true;
    }
    return supported.includes(agentId);
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const startedAt = new Date().toISOString();

    if (!this.available) {
      const error: ExecutionError = {
        code: 'AGENT_EXECUTOR_UNAVAILABLE',
        message: `Executor ${this.id} is unavailable`,
        retryable: false,
      };
      const completedAt = new Date().toISOString();
      return {
        success: false,
        error,
        startedAt,
        completedAt,
        durationMs: 0,
      };
    }

    this.calls.push(request);

    const delayMs = this.options.delayMs ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const stepAttempts = this.calls.filter((call) => call.stepId === request.stepId).length;

    if (this.options.throwError !== undefined) {
      throw this.options.throwError;
    }

    const succeed =
      this.options.succeed !== false &&
      (this.options.succeedAfterAttempts === undefined ||
        stepAttempts >= this.options.succeedAfterAttempts);

    const completedAt = new Date().toISOString();

    if (!succeed) {
      return {
        success: false,
        error: this.options.error ?? {
          code: 'AGENT_EXECUTION_FAILED',
          message: 'Agent execution failed',
          retryable: true,
        },
        startedAt,
        completedAt,
        durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
      };
    }

    return {
      success: true,
      output: this.options.output ?? { ok: true },
      startedAt,
      completedAt,
      durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
    };
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelledExecutions.add(executionId);
  }

  status(): { readonly available: boolean; readonly details?: Readonly<Record<string, unknown>> } {
    return {
      available: this.available,
      details: { calls: this.calls.length },
    };
  }
}

/** Resolves the executor that can execute a given agent id (prompt §4). */
export class StaticExecutorRegistry implements ExecutorRegistry {
  private readonly executors: readonly AgentExecutor[];

  constructor(executors: readonly AgentExecutor[]) {
    this.executors = executors;
  }

  resolve(agentId: string): AgentExecutor | undefined {
    return this.executors.find(
      (executor) => executor.canExecute(agentId) && executor.status().available,
    );
  }
}

export type { ExecutionError };
