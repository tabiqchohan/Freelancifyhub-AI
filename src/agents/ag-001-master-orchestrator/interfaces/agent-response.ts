import type { AgentMetadata } from './agent-metadata.js';
import type { ErrorInfo } from '../types/index.js';
import type { ExecutionStatus } from '../types/index.js';
import type { RequestId } from '../types/index.js';

/** Normalised result returned by an agent. */
export interface AgentResponse<P = unknown> {
  /** Agent that produced the response. */
  readonly agentId: string;
  /** The request this response satisfies. */
  readonly requestId: RequestId;
  readonly status: ExecutionStatus;
  readonly payload?: P;
  readonly metadata: AgentMetadata;
  readonly error?: ErrorInfo;
}
