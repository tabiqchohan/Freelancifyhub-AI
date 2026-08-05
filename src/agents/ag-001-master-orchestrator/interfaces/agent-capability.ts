/** A capability an agent can expose to the orchestrator. */
export interface AgentCapability {
  /** Stable capability identifier (for example `draft.proposal`). */
  readonly id: string;
  /** Human-readable capability name. */
  readonly name: string;
  readonly description?: string;
  /** Whether the capability is currently enabled. */
  readonly enabled: boolean;
}
