import type { Logger } from 'pino';

import { RuntimeAgentEventType } from '../agents/runtime/types.js';
import type { RuntimeAgentEvent } from '../agents/runtime/types.js';
import { MemoryEventType } from '../agents/ag-002-memory-manager/events/index.js';
import type { MemoryEvent } from '../agents/ag-002-memory-manager/events/index.js';
import { InMemoryEventLog } from '../agents/ag-002-memory-manager/events/index.js';
import type { PostgresEventSink } from '../agents/ag-002-memory-manager/events/postgres.js';
import { createOrchestratorLogger } from '../agents/ag-001-master-orchestrator/utils/logger.js';

/**
 * Phase 6 — Runtime → AG-002 event bridge.
 *
 * Single authoritative event infrastructure (AG-002). Every production runtime
 * event ({@link RuntimeAgentEvent}) is mapped to an AG-002 {@link MemoryEvent}
 * and appended to {@link InMemoryEventLog} (the canonical audit log). In
 * durable mode the same event is mirrored through {@link PostgresEventSink} so
 * the audit trail survives restarts. No second event system is introduced;
 * security/authorization events continue to flow through AG-002's own emitter.
 */

/** Options for constructing a {@link RuntimeEventBridge}. */
export interface RuntimeEventBridgeOptions {
  /** Canonical AG-002 audit log (default: a fresh in-memory log). */
  readonly log?: InMemoryEventLog;
  /** Durable sink used in durable storage mode; optional. */
  readonly postgresSink?: PostgresEventSink;
  /** AG-002 namespace assigned to bridged audit events. */
  readonly namespace?: string;
  readonly logger?: Logger;
}

/** The bridge: receives runtime events and persists AG-002 audit events. */
export class RuntimeEventBridge {
  private readonly log: InMemoryEventLog;
  private readonly postgresSink: PostgresEventSink | undefined;
  private readonly namespace: string;
  private readonly logger: Logger;

  constructor(options: RuntimeEventBridgeOptions = {}) {
    this.log = options.log ?? new InMemoryEventLog();
    this.postgresSink = options.postgresSink;
    this.namespace = options.namespace ?? 'system:runtime';
    this.logger = options.logger ?? createOrchestratorLogger('runtime-event-bridge');
  }

  /** The canonical AG-002 log the bridge appends to. */
  get eventLog(): InMemoryEventLog {
    return this.log;
  }

  /** Synchronously appends a runtime event to the canonical AG-002 log. */
  accept(event: RuntimeAgentEvent): void {
    const memoryEvent = this.map(event);
    try {
      this.log.append(memoryEvent);
    } catch (error) {
      this.logger.warn({ error, type: event.type }, 'failed to append runtime event');
    }

    if (this.postgresSink !== undefined) {
      void this.postgresSink.persist(memoryEvent).catch((error) => {
        this.logger.error(
          { error, type: event.type },
          'failed to mirror runtime event to postgres',
        );
      });
    }
  }

  private map(event: RuntimeAgentEvent): MemoryEvent {
    const metadata: Record<string, boolean | string> = {
      runtimeEventType: event.type,
      executionId: event.executionId,
      stepId: event.stepId,
      agentId: event.agentId,
    };
    const success = successOf(event.metadata?.['success']);
    const stage = stageOf(event.metadata?.['orchestrationStage']);
    if (success !== undefined) {
      metadata['success'] = success;
    }
    if (stage !== undefined) {
      metadata['orchestrationStage'] = stage;
    }

    return {
      type: this.eventTypeFor(event.type),
      traceId: event.traceId,
      occurredAt: event.occurredAt,
      timestamp: event.occurredAt,
      namespace: this.namespace,
      key: `runtime:${event.agentId}:${event.type}`,
      requestId: event.requestId,
      correlationId: event.executionId,
      source: 'system',
      service: 'runtime-agent',
      category: 'system',
      severity: this.severityFor(event.type),
      metadata,
    };
  }

  private eventTypeFor(type: RuntimeAgentEventType): MemoryEvent['type'] {
    switch (type) {
      case RuntimeAgentEventType.ExecutionCompleted:
        return MemoryEventType.Retrieved;
      case RuntimeAgentEventType.ExecutionFailed:
        return MemoryEventType.AccessDenied;
      case RuntimeAgentEventType.CancellationRequested:
        return MemoryEventType.Deleted;
      case RuntimeAgentEventType.MemoryRetrievalSucceeded:
        return MemoryEventType.Retrieved;
      case RuntimeAgentEventType.MemoryRetrievalFailed:
        return MemoryEventType.AccessDenied;
      case RuntimeAgentEventType.ExecutionStarted:
      case RuntimeAgentEventType.MemoryRetrievalStarted:
      default:
        return MemoryEventType.Activated;
    }
  }

  private severityFor(type: RuntimeAgentEventType): 'info' | 'warning' {
    switch (type) {
      case RuntimeAgentEventType.ExecutionFailed:
      case RuntimeAgentEventType.CancellationRequested:
      case RuntimeAgentEventType.MemoryRetrievalFailed:
        return 'warning';
      default:
        return 'info';
    }
  }
}

/** Creates a runtime event bridge (Phase 6). */
export function createRuntimeEventBridge(
  options: RuntimeEventBridgeOptions = {},
): RuntimeEventBridge {
  return new RuntimeEventBridge(options);
}

/** Coerces an unknown metadata value into a boolean-or-undefined. */
function successOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  return undefined;
}

/** Coerces an unknown metadata value into a string-or-undefined. */
function stageOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}
