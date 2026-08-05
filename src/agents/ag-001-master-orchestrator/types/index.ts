/** Shared, transport-agnostic types for the Master Orchestrator foundations. */

/** Stable agent identifier in the form `AG-NNN`. */
export type AgentId = string;

/** Correlation identifier propagated across every agent (blueprint §23). */
export type TraceId = string;

/** Identifier for a single request/invocation. */
export type RequestId = string;

/** ISO-8601 timestamp string. */
export type IsoTimestamp = string;

/** Slot names the pipeline is composed of. */
export type PipelineStageKind = 'input' | 'context' | 'process' | 'output';

/** Team scope an agent belongs to (catalog §3). */
export enum AgentCategory {
  Core = 'Core',
  Client = 'Client',
  Freelancer = 'Freelancer',
  Marketplace = 'Marketplace',
  Marketing = 'Marketing',
  Admin = 'Admin',
}

/** Rolled-lifecycle status (catalog §2). */
export enum AgentStatus {
  Draft = 'Draft',
  InDevelopment = 'InDevelopment',
  Testing = 'Testing',
  Production = 'Production',
  Maintenance = 'Maintenance',
  Retired = 'Retired',
}

/** Outcome of an execution step. */
export enum ExecutionStatus {
  Pending = 'Pending',
  Running = 'Running',
  Succeeded = 'Succeeded',
  Failed = 'Failed',
  TimedOut = 'TimedOut',
  Cancelled = 'Cancelled',
}

/** What a declared dependency refers to. */
export enum DependencyType {
  Agent = 'agent',
  Memory = 'memory',
  Knowledge = 'knowledge',
  Tool = 'tool',
  Service = 'service',
}

/** Structural limits declared by an agent. */
export interface AgentLimits {
  readonly maxTokens: number;
  readonly maxAttempts: number;
  readonly timeoutMs?: number;
}

/** Normalised, machine-readable error payload (blueprint §21.2). */
export interface ErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}
