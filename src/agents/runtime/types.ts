import type { ExecutionError } from '../ag-001-master-orchestrator/execution/index.js';
import type {
  AgentCapability,
  AgentConfiguration,
  AgentDependency,
} from '../ag-001-master-orchestrator/interfaces/index.js';
import type { AgentId, IsoTimestamp, TraceId } from '../ag-001-master-orchestrator/types/index.js';
import type { MemoryNamespace, MemorySecurityLevel } from '../ag-002-memory-manager/index.js';

export type {
  AgentCapability,
  AgentConfiguration,
  AgentDependency,
  AgentId,
  IsoTimestamp,
  TraceId,
  ExecutionError,
  MemoryNamespace,
  MemorySecurityLevel,
};

/** Cooperative cancellation token supplied to every running agent. */
export interface CancellationSignal {
  readonly requested: boolean;
  waitForCancellation(): Promise<void>;
}

/** Redacted memory item delivered to a runtime agent (AG-002 context). */
export interface RuntimeMemoryItem {
  readonly id: string;
  readonly namespace: MemoryNamespace;
  readonly key: string;
  readonly content: string;
  readonly priority: string;
  readonly source: string;
  readonly securityLevel: MemorySecurityLevel;
  readonly tokenEstimate: number;
}

/** Request-scoped execution context handed to a {@link RuntimeAgent}. */
export interface RuntimeAgentExecutionContext {
  readonly agentId: AgentId;
  readonly executionId: string;
  readonly stepId: string;
  readonly traceId: TraceId;
  readonly requestId: string;
  readonly attempt: number;
  readonly startedAt: IsoTimestamp;
  readonly timeoutMs: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly memory: readonly RuntimeMemoryItem[];
  readonly signal: CancellationSignal;
}

/** Result produced by a {@link RuntimeAgent}. */
export interface RuntimeAgentExecutionResult {
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: ExecutionError;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Static availability reported by an agent at execution time. */
export interface AgentAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * A registered, executable agent in the production runtime. Carries its own
 * {@link AgentConfiguration} (single source of truth shared with routing) and
 * a deterministic `execute` handler.
 */
export interface RuntimeAgent {
  readonly configuration: AgentConfiguration;
  readonly availability: AgentAvailability;
  execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult>;
}

/** Typed events emitted by the production executor (Phase 6 bridge input). */
export enum RuntimeAgentEventType {
  ExecutionStarted = 'AGENT_EXECUTION_STARTED',
  ExecutionCompleted = 'AGENT_EXECUTION_COMPLETED',
  ExecutionFailed = 'AGENT_EXECUTION_FAILED',
  CancellationRequested = 'AGENT_CANCELLATION_REQUESTED',
  MemoryRetrievalStarted = 'AGENT_MEMORY_RETRIEVAL_STARTED',
  MemoryRetrievalSucceeded = 'AGENT_MEMORY_RETRIEVAL_SUCCEEDED',
  MemoryRetrievalFailed = 'AGENT_MEMORY_RETRIEVAL_FAILED',
}

/** A single typed runtime event emitted by {@link ProductionAgentExecutor}. */
export interface RuntimeAgentEvent {
  readonly type: RuntimeAgentEventType;
  readonly executionId: string;
  readonly stepId: string;
  readonly agentId: AgentId;
  readonly traceId: TraceId;
  readonly requestId: string;
  readonly occurredAt: IsoTimestamp;
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
