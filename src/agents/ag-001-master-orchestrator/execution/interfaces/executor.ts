import type { AgentId, IsoTimestamp } from '../../types/index.js';
import type { ExecutionError, ExecutionPolicy, ExecutionReference } from '../types/index.js';

/** The resolved, executor-facing request for a single step (prompt §3/§10). */
export interface AgentExecutionRequest {
  readonly executionId: string;
  readonly stepId: string;
  readonly agentId: AgentId;
  /** Resolved input values keyed by reference id (execution-local only). */
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly policy: ExecutionPolicy;
  readonly traceId?: string;
}

/** The result an agent executor returns (never external in Sprint 6). */
export interface AgentExecutionResult {
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: ExecutionError;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type { ExecutionReference };
