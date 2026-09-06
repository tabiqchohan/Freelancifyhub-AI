/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. Execution gate.
 *
 * The gateway is the single admission point through which AG-001 executes an
 * agent. It validates (in a fixed order): registered identity, lifecycle
 * readiness, agent version, capability claims, execution-mode claims,
 * permission claims, and concurrency limits. Every rejection is a normalized
 * `PlatformGateFailure` plus a typed policy event and a metric counter.
 *
 * Denials are NOT authorization decisions: AG-004/request-actor authorization
 * still applies independently at the tool/action boundary.
 */

import type { AgentId, RequestId, TraceId } from '../ag-001-master-orchestrator/types/index.js';
import { AgentPlatformError } from './errors.js';
import type { AgentPlatformErrorCode } from './errors.js';
import { capabilityDeniedEvent, executionDeniedEvent, permissionDeniedEvent } from './events.js';
import type { AgentPlatformEvent, AgentPlatformEventLog } from './events.js';
import type { AgentPlatformMetrics } from './metrics.js';
import type { AgentExecutionGateInput, AgentExecutionLease } from './types.js';
import type { AgentDefinitionRegistry } from './registry.js';

/** Normalized, safe rejection surfaced by the gate. */
export interface PlatformGateFailure {
  readonly code: AgentPlatformErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Result of opening an execution slot. */
export type PlatformGateResult =
  | { readonly lease: AgentExecutionLease; readonly failure?: never }
  | { readonly failure: PlatformGateFailure; readonly lease?: never };

/** Input for closing an execution slot. */
export interface ExecutionCompletionInput {
  readonly agentId: AgentId;
  readonly executionId: string;
  /** performance.now() captured at begin() so durations stay deterministic. */
  readonly startedAtMs?: number;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
}

/** Safe metadata carried into a policy event (subset of events.ts EventInput). */
interface PolicyEventInput {
  readonly occurredAt: string;
  readonly agentId?: string;
  readonly version?: string;
  readonly lifecycleState?: string;
  readonly executionMode?: string;
  readonly capability?: string;
  readonly permission?: string;
  readonly reasonCode?: string;
  readonly executionId?: string;
  readonly requestId?: string;
}

/** Extra metadata selective to a rejection branch. */
interface RejectExtra {
  readonly version?: string;
  readonly attributeId?: string;
}

/** Options for the execution gateway. */
export interface AgentPlatformGatewayOptions {
  readonly registry: AgentDefinitionRegistry;
  readonly metrics?: AgentPlatformMetrics;
  readonly eventLog?: AgentPlatformEventLog;
  readonly now?: () => string;
  readonly performanceNow?: () => number;
}

/** The Sprint 19 execution gate. */
export class AgentPlatformGateway {
  readonly name = 'agent-platform-gateway';

  private readonly registry: AgentDefinitionRegistry;
  private readonly metrics?: AgentPlatformMetrics;
  private readonly eventLog?: AgentPlatformEventLog;
  private readonly now: () => string;
  private readonly performanceNow: () => number;

  constructor(options: AgentPlatformGatewayOptions) {
    this.registry = options.registry;
    this.metrics = options.metrics;
    this.eventLog = options.eventLog;
    this.now = options.now ?? (() => new Date().toISOString());
    this.performanceNow = options.performanceNow ?? (() => performance.now());
  }

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  /**
   * Requests an execution slot. Returns a lease on success or a normalized
   * failure; never throws for policy reasons (implementation defects still
   * throw). The lease carries the immutable tool allowlist for defense in depth.
   */
  beginExecution(input: AgentExecutionGateInput): PlatformGateResult {
    const agentId = input.agentId;
    const lifecycle = this.registry.lifecycleController;
    const definition = this.registry.getAgent(agentId);

    // 0. Registered identity.
    if (definition === undefined) {
      return this.reject(
        'AGENT_NOT_FOUND',
        input,
        { message: `Agent ${agentId} is not registered with the platform`, retryable: false },
        executionDeniedEvent,
      );
    }

    // 1. Lifecycle readiness (reserves the slot).
    try {
      lifecycle.beginExecution(agentId);
    } catch (error) {
      if (error instanceof AgentPlatformError) {
        return this.reject(
          error.code,
          input,
          { message: error.message, retryable: false },
          executionDeniedEvent,
          { version: definition.version },
        );
      }
      throw error;
    }

    // 2. Version compatibility.
    if (input.agentVersion !== undefined && input.agentVersion !== definition.version) {
      lifecycle.endExecution(agentId);
      return this.reject(
        'AGENT_VERSION_CONFLICT',
        input,
        {
          message: `Agent version ${input.agentVersion} does not match registered ${definition.version}`,
          retryable: false,
        },
        executionDeniedEvent,
        { version: definition.version },
      );
    }

    // 3. Capability claims.
    for (const capabilityId of input.capabilities) {
      const declared = definition.capabilities.find((c) => c.id === capabilityId);
      if (declared === undefined || !declared.enabled) {
        lifecycle.endExecution(agentId);
        this.metrics?.recordCapabilityDenial();
        return this.reject(
          'AGENT_CAPABILITY_DENIED',
          input,
          {
            message: `Agent ${agentId} does not declare capability ${capabilityId}`,
            retryable: false,
          },
          capabilityDeniedEvent,
          { version: definition.version, attributeId: capabilityId },
        );
      }
    }

    // 4. Execution-mode claim.
    if (!definition.executionModes.includes(input.executionMode)) {
      lifecycle.endExecution(agentId);
      this.metrics?.recordCapabilityDenial();
      return this.reject(
        'AGENT_CAPABILITY_DENIED',
        input,
        {
          message: `Agent ${agentId} does not support execution mode ${input.executionMode}`,
          retryable: false,
        },
        capabilityDeniedEvent,
        { version: definition.version, attributeId: input.executionMode },
      );
    }

    // 5. Permission claims.
    for (const permission of input.permissions) {
      if (!definition.permissions.includes(permission)) {
        lifecycle.endExecution(agentId);
        this.metrics?.recordPermissionDenial();
        return this.reject(
          'AGENT_PERMISSION_DENIED',
          input,
          {
            message: `Agent ${agentId} is not granted permission ${permission}`,
            retryable: false,
          },
          permissionDeniedEvent,
          { version: definition.version, attributeId: permission },
        );
      }
    }

    // 6. Concurrency limit (this execution is already counted in flight).
    const active = lifecycle.activeExecutionCount(agentId);
    if (active > definition.limits.maxConcurrentExecutions) {
      lifecycle.endExecution(agentId);
      this.metrics?.recordExecutionLimitDenial();
      return this.reject(
        'AGENT_EXECUTION_LIMIT_REACHED',
        input,
        {
          message: `Agent ${agentId} reached its concurrency limit of ${definition.limits.maxConcurrentExecutions}`,
          retryable: true,
        },
        executionDeniedEvent,
        { version: definition.version },
      );
    }

    // Success: acknowledge the reservation and record the start.
    this.metrics?.recordExecutionStarted(active);
    return {
      lease: Object.freeze({
        agentId,
        executionId: input.executionId,
        requestId: input.requestId,
        traceId: input.traceId,
        correlationId: input.correlationId,
        allowedTools: definition.allowedTools,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  /** Closes a slot and records deterministic duration. Safe to call twice. */
  endExecution(input: ExecutionCompletionInput): void {
    this.registry.lifecycleController.endExecution(input.agentId);
    if (this.metrics === undefined) {
      return;
    }
    if (input.startedAtMs !== undefined) {
      this.metrics.recordExecutionCompleted(Math.max(0, this.performanceNow() - input.startedAtMs));
    } else {
      this.metrics.recordExecutionCompleted(0);
    }
  }

  // -------------------------------------------------------------------------
  // Defense in depth
  // -------------------------------------------------------------------------

  /** Whether the platform manages this agent (registered identity). Executors
   * gate only managed agents; unmanaged runtime agents keep legacy behavior. */
  isPlatformManaged(agentId: AgentId): boolean {
    return this.registry.getAgent(agentId) !== undefined;
  }

  /** Whether the agent's allowlist covers a tool. The agentic loop re-checks
   * the same allowlist at call time (Sprint 19 §8). */
  isToolAllowed(agentId: AgentId, toolName: string): boolean {
    const definition = this.registry.getAgent(agentId);
    if (definition === undefined) {
      return false;
    }
    return definition.allowedTools.includes(toolName);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private reject(
    code: AgentPlatformErrorCode,
    input: AgentExecutionGateInput,
    failure: { readonly message: string; readonly retryable: boolean },
    eventFactory: (input: PolicyEventInput) => AgentPlatformEvent,
    extra: RejectExtra = {},
  ): PlatformGateResult {
    this.metrics?.recordRejectedExecution();
    this.emitEvent(eventFactory, input, code, extra);
    const details: Record<string, unknown> = {
      executionId: input.executionId,
      lifecycleState: this.registry.lifecycleStateOf(input.agentId)?.toString(),
      executionMode: input.executionMode,
      requestId: input.requestId,
      traceId: input.traceId,
    };
    if (code === 'AGENT_CAPABILITY_DENIED' && extra.attributeId !== undefined) {
      details.capability = extra.attributeId;
    }
    if (code === 'AGENT_PERMISSION_DENIED' && extra.attributeId !== undefined) {
      details.permission = extra.attributeId;
    }
    return {
      failure: {
        code,
        message: failure.message,
        retryable: failure.retryable,
        details: clean(details),
      },
    };
  }

  /** Appends a policy event; observability must never block admission. */
  private emitEvent(
    eventFactory: (input: PolicyEventInput) => AgentPlatformEvent,
    input: AgentExecutionGateInput,
    code: AgentPlatformErrorCode,
    extra: RejectExtra,
  ): void {
    if (this.eventLog === undefined) {
      return;
    }
    try {
      this.eventLog.append(
        eventFactory({
          occurredAt: this.now(),
          agentId: input.agentId,
          version: extra.version,
          lifecycleState: this.registry.lifecycleStateOf(input.agentId)?.toString(),
          executionMode: input.executionMode,
          ...(code === 'AGENT_CAPABILITY_DENIED' && extra.attributeId !== undefined
            ? { capability: extra.attributeId }
            : {}),
          ...(code === 'AGENT_PERMISSION_DENIED' && extra.attributeId !== undefined
            ? { permission: extra.attributeId }
            : {}),
          reasonCode: code,
          executionId: input.executionId,
          requestId: input.requestId,
        }),
      );
    } catch {
      // Observability must never affect admission correctness.
    }
  }
}

/** Maps an unknown rejection (e.g. aggregator error) to a normalized failure. */
export function normalizeGateFailure(error: unknown, agentId: AgentId): PlatformGateFailure {
  if (error instanceof AgentPlatformError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === 'AGENT_EXECUTION_LIMIT_REACHED',
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return { code: 'AGENT_NOT_READY', message: error.message, retryable: false };
  }
  return {
    code: 'AGENT_NOT_READY',
    message: `Agent ${agentId} rejected execution`,
    retryable: false,
  };
}

function clean(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return Object.freeze(out);
}
