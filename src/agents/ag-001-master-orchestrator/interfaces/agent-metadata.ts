import type { RequestId } from '../types/index.js';
import type { ExecutionStatus } from '../types/index.js';
import type { TraceId } from '../types/index.js';

/** Standardised metadata attached to an agent execution. */
export interface AgentMetadata {
  /** Agent that produced the result. */
  readonly agentId: string;
  /** Correlation id propagated from the request. */
  readonly traceId: TraceId;
  readonly requestId: RequestId;
  readonly startedAt: string;
  readonly completedAt?: string;
  /** Elapsed wall-clock time in milliseconds. */
  readonly durationMs: number;
  /** Number of attempts spent (including retries). */
  readonly attempts: number;
  readonly status: ExecutionStatus;
}
