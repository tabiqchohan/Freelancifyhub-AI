/**
 * Sprint 26 — AIOS event system of record.
 *
 * Every lifecycle transition is recorded as an {@link AiosEvent} in a bounded
 * ring buffer and forwarded (PERSIST_EVENTS) to the shared runtime event
 * bridge, which maps it into the AG-002 canonical audit event log. The AIOS
 * never forges AG-002 events; it only maps its own typed events through the
 * established bridge.
 */

import type { RuntimeAgentEvent } from '../agents/runtime/types.js';
import { RuntimeAgentEventType } from '../agents/runtime/types.js';
import { AiosStage, type AiosEvent } from './types.js';

export interface AiosEventLogOptions {
  readonly window?: number;
  readonly onForward?: (event: RuntimeAgentEvent) => void;
}

/** Bounded ring buffer of AIOS events (the AIOS system of record). */
export class AiosEventLog {
  private readonly events: AiosEvent[] = [];
  private readonly window: number;
  private readonly onForward?: (event: RuntimeAgentEvent) => void;
  private nextEventId = 1;

  constructor(options: AiosEventLogOptions = {}) {
    this.window = options.window ?? 200;
    this.onForward = options.onForward;
  }

  accept(event: AiosEvent): void {
    this.events.push(event);
    if (this.events.length > this.window) {
      this.events.splice(0, this.events.length - this.window);
    }
    if (this.onForward !== undefined) {
      this.onForward(toRuntimeAgentEvent(event));
    }
  }

  /** Emits a lifecycle event for a request. */
  emitFor(
    requestId: string,
    traceId: string,
    type: string,
    stage: AiosStage,
    metadata?: Readonly<Record<string, unknown>>,
  ): void {
    this.accept({
      eventId: `evt-${requestId}-${this.nextEventId++}`,
      requestId,
      traceId,
      type,
      stage,
      occurredAt: new Date().toISOString(),
      metadata,
    });
  }

  /** Events recorded for one request (newest first). */
  eventsFor(requestId: string): readonly AiosEvent[] {
    return this.events.filter((e) => e.requestId === requestId).reverse();
  }

  /** Injects a probe event (observability scenario — never affects logic). */
  injectProbe(requestId: string, traceId: string, favoriteColor = '#33FF57'): void {
    this.accept({
      eventId: `evt-${requestId}-probe`,
      requestId,
      traceId,
      type: 'aios.probe',
      stage: AiosStage.Completed,
      occurredAt: new Date().toISOString(),
      metadata: { favoriteColor, aiosProbe: true, ts: new Date().getTime() },
    });
  }

  probeFor(requestId: string): AiosEvent | undefined {
    return this.events.find((e) => e.requestId === requestId && e.type === 'aios.probe');
  }

  snapshot(): readonly AiosEvent[] {
    return [...this.events];
  }

  recordCounts(prefixType?: string): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const event of this.events) {
      const key =
        prefixType !== undefined && event.type.startsWith(prefixType) ? prefixType : event.type;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }
}

/** Maps an AIOS event onto the runtime event bridge contract (AG-002 log). */
export function toRuntimeAgentEvent(event: AiosEvent): RuntimeAgentEvent {
  const type = runtimeTypeFor(event.type);
  const agentId = typeof event.metadata?.agentId === 'string' ? event.metadata.agentId : 'AIOS';
  return {
    type,
    executionId: event.requestId,
    stepId: event.stage ?? '',
    agentId,
    traceId: event.traceId ?? event.requestId,
    requestId: event.requestId,
    occurredAt: event.occurredAt,
    errorCode: typeof event.metadata?.errorCode === 'string' ? event.metadata.errorCode : undefined,
    metadata: {
      gateway: 'ai-operating-system',
      eventType: event.type,
      ...(event.metadata ?? {}),
    },
  };
}

function runtimeTypeFor(type: string): RuntimeAgentEventType {
  switch (type) {
    case 'request.failed':
    case 'execution.failed':
      return RuntimeAgentEventType.ExecutionFailed;
    case 'request.cancelled':
    case 'execution.cancelled':
      return RuntimeAgentEventType.CancellationRequested;
    case 'request.timed_out':
    case 'execution.timed_out':
      return RuntimeAgentEventType.ExecutionFailed;
    default:
      return RuntimeAgentEventType.ExecutionCompleted;
  }
}
