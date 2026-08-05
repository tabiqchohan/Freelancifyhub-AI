import type { DependencyType } from '../types/index.js';

/** A declared dependency of an agent on another component. */
export interface AgentDependency {
  readonly type: DependencyType;
  /** Identifier of the dependency (agent id, tool id, KB id, namespace...). */
  readonly id: string;
  /** Whether the dependency is required for the agent to function. */
  readonly required: boolean;
  /** Optional scope reference used by memory/knowledge (permission-aware). */
  readonly scope?: string;
}
