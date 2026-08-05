import type { AgentMetadata } from './agent-metadata.js';
import type { ErrorInfo } from '../types/index.js';

/** Result of executing one agent pipeline. */
export interface ExecutionResult<P = unknown> {
  readonly success: boolean;
  readonly payload?: P;
  readonly error?: ErrorInfo;
  readonly metadata: AgentMetadata;
}
