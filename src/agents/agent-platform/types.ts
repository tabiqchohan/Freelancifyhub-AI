/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. Domain contracts.
 *
 * The Agent Platform is a formal contract layer between agent identity/capability/
 * lifecycle metadata and the AG-001 runtime. Definitions are server-controlled
 * and immutable at runtime; they never originate from user or model input.
 */

import type {
  AgentCapability,
  AgentConfiguration,
  AgentDependency,
} from '../ag-001-master-orchestrator/interfaces/index.js';
import type {
  AgentCategory,
  AgentId,
  AgentStatus,
  IsoTimestamp,
  RequestId,
  TraceId,
} from '../ag-001-master-orchestrator/types/index.js';

export type {
  AgentCapability,
  AgentConfiguration,
  AgentDependency,
  AgentCategory,
  AgentId,
  AgentStatus,
  IsoTimestamp,
  RequestId,
  TraceId,
};

export type { AgentPermissionId } from './constants.js';

/** Supported agent execution modes (Sprint 19 §7). */
export enum AgentExecutionMode {
  /** No LLM call unless explicitly required by the definition. */
  Deterministic = 'Deterministic',
  /** LLM reasoning may be used. */
  Reasoning = 'Reasoning',
  /** LLM reasoning plus bounded tool execution through Sprint 18. */
  Agentic = 'Agentic',
}

/** Structural execution limits applied to an agent (Sprint 19 §10). */
export interface AgentLimits {
  /** Per-execution deadline in milliseconds. */
  readonly maxExecutionTimeMs: number;
  /** Maximum reasoning turns per execution (agentic mode). */
  readonly maxReasoningTurns: number;
  /** Maximum tool calls per execution (agentic mode). */
  readonly maxToolCalls: number;
  /** Maximum input context budget in bytes. */
  readonly maxContextBytes: number;
  /** Maximum output budget in bytes. */
  readonly maxOutputBytes: number;
  /** Maximum concurrent executions allowed for this agent. */
  readonly maxConcurrentExecutions: number;
  /** Optional cost/token budget; absent means unrestricted. Sprint 18 token
   * budget still applies when the agentic loop is in use. */
  readonly maxTokenBudget?: number;
}

/** Partial limits accepted during definition parsing (defaults applied). */
export type AgentLimitsInput = Partial<AgentLimits>;

/**
 * The immutable, server-controlled contract describing an agent.
 * Roughly maps to AG-001 {@link AgentConfiguration} plus platform metadata.
 */
export interface AgentDefinition {
  readonly agentId: AgentId;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly team: string;
  readonly category: AgentCategory;
  /** Deployment/rolled-lifecycle status (Agent Catalog axis). */
  readonly status: AgentStatus;
  readonly capabilities: readonly AgentCapability[];
  readonly executionModes: readonly AgentExecutionMode[];
  /** Tool allowlist. The model and users can never expand this list. */
  readonly allowedTools: readonly string[];
  /** Declarative permissions (upserted with AG-004 / request-actor auth). */
  readonly permissions: readonly string[];
  readonly limits: AgentLimits;
  readonly dependencies: readonly AgentDependency[];
  /** Safe, validated configuration. Never model-/user-mutable. */
  readonly configuration: Readonly<Record<string, unknown>>;
}

/** A fully validated definition as registered. */
export interface AgentRegistration {
  readonly definition: AgentDefinition;
  readonly registeredAt: IsoTimestamp;
}

/** Ownership lease returned when an execution passes the platform gate. */
export interface AgentExecutionLease {
  readonly agentId: AgentId;
  readonly executionId: string;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly correlationId?: string;
  /** The agent's immutable tool allowlist (defense in depth). */
  readonly allowedTools: readonly string[];
}

/** Input the executor provides when requesting an execution slot. */
export interface AgentExecutionGateInput {
  readonly executionId: string;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly correlationId?: string;
  readonly agentId: AgentId;
  readonly agentVersion?: string;
  /** The effective execution mode the executor is about to run. */
  readonly executionMode: AgentExecutionMode;
  /** Capability ids the runtime agent claims at execution time. */
  readonly capabilities: readonly string[];
  /** Permissions the runtime agent claims at execution time. */
  readonly permissions: readonly string[];
}

/** Safe aggregated platform status (health/readiness). No secrets. */
export interface AgentPlatformStatusSnapshot {
  readonly registered: number;
  readonly ready: number;
  readonly running: number;
  readonly paused: number;
  readonly draining: number;
  readonly disabled: number;
  readonly failed: number;
  readonly terminated: number;
  readonly activeExecutions: number;
  /** Healthy when at least one agent is ready/running. */
  readonly healthy: boolean;
}
