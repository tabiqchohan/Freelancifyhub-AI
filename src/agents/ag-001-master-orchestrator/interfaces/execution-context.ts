import type { AgentCategory, AgentStatus, IsoTimestamp } from '../types/index.js';
import type { AgentCapability } from './agent-capability.js';
import type { AgentDependency } from './agent-dependency.js';

/** The mutable execution context handed to a pipeline stage. */
export interface ExecutionContext<State = Readonly<Record<string, unknown>>> {
  readonly agentId: string;
  readonly traceId: string;
  readonly requestId: string;
  readonly startedAt: IsoTimestamp;
  readonly state: State;
}

/** Static, immutable contract describing an agent (manifest shape). */
export interface AgentConfiguration {
  readonly agentId: string;
  readonly name: string;
  readonly version: string;
  readonly category: AgentCategory;
  readonly status: AgentStatus;
  readonly capabilities: readonly AgentCapability[];
  readonly dependencies: readonly AgentDependency[];
  readonly limits?: {
    readonly maxTokens: number;
    readonly maxAttempts: number;
    readonly timeoutMs?: number;
  };
}
