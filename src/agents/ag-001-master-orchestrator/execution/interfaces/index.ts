import type { AgentExecutionRequest, AgentExecutionResult } from './executor.js';
import type {
  ExecutionEvent,
  ExecutionRequest,
  ExecutionRun,
  ExecutionResult,
} from '../types/index.js';
import type { ExecutionStep, ExecutionCondition } from '../types/index.js';
import type { ExecutionConfig } from '../config/index.js';

/** Contract any agent executor must satisfy (prompt §3). */
export interface AgentExecutor {
  readonly id: string;
  /** Executes a single step for the given agent (never external). */
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  /** Whether this executor can execute the given agent id. */
  canExecute(agentId: string): boolean;
  /** Best-effort cancellation of a running execution. */
  cancel(executionId: string): Promise<void>;
  /** Safe health/status metadata for observability (prompt §3). */
  status(): { readonly available: boolean; readonly details?: Readonly<Record<string, unknown>> };
}

/** Resolves the executor responsible for a given agent id (prompt §3/§4). */
export interface ExecutorRegistry {
  resolve(agentId: string): AgentExecutor | undefined;
}

/** Emits deterministic, ordered execution events (prompt §17). */
export interface ExecutionEventEmitter {
  emit(event: ExecutionEvent): void;
}

/** Evaluates a declarative condition deterministically (prompt §8). */
export interface ConditionEvaluator {
  evaluate(condition: ExecutionCondition, context: ConditionEvaluationContext): boolean;
}

/** Context a condition evaluator needs (prompt §8/§10). */
export interface ConditionEvaluationContext {
  readonly resolve: (field: string) => unknown | undefined;
}

/** Contract every execution-mode strategy must satisfy (prompt §5–§9). */
export interface ExecutionModeStrategy {
  readonly name: string;
  execute(input: StrategyInput): Promise<ExecutionStrategyOutcome>;
}

/** Input handed to a strategy by the engine. */
export interface StrategyInput {
  readonly run: ExecutionRun;
  readonly executeStep: (step: ExecutionStep) => Promise<void>;
  readonly evaluateCondition: (
    condition: ExecutionCondition,
    context: ConditionEvaluationContext,
  ) => boolean;
  readonly isCancelled: () => boolean;
  readonly stopRequested: () => boolean;
  readonly shouldSkipStep: (step: ExecutionStep) => boolean;
}

/** Terminal outcome a strategy reports back to the engine. */
export interface ExecutionStrategyOutcome {
  readonly completed: boolean;
}

/** Contract the execution engine satisfies (prompt §4). */
export interface ExecutionEngineContract {
  readonly name: string;
  readonly version: string;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

export type {
  AgentExecutionRequest,
  AgentExecutionResult,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionRun,
  ExecutionResult,
  ExecutionStep,
  ExecutionCondition,
  ExecutionConfig,
};
