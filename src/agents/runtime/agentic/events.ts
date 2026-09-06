/**
 * Sprint 18 — Agentic Tool-Calling. Observable event trail.
 *
 * Safe, append-only audit of agentic operations. Events never carry secrets,
 * raw prompts, chain-of-thought, or raw tool arguments that may contain
 * secrets — only identifiers, counts, durations, statuses, and decision kinds.
 */

/** Categories of agentic lifecycle events. */
export type AgenticEventCategory = 'operation' | 'reasoning' | 'tool' | 'outcome';

/** Typed agentic event kinds. */
export type AgenticEventType =
  | 'agentic.operation.started'
  | 'agentic.reasoning.started'
  | 'agentic.reasoning.completed'
  | 'agentic.tool.requested'
  | 'agentic.tool.authorized'
  | 'agentic.tool.rejected'
  | 'agentic.tool.started'
  | 'agentic.tool.completed'
  | 'agentic.tool.failed'
  | 'agentic.loop.completed'
  | 'agentic.loop.failed'
  | 'agentic.loop.cancelled'
  | 'agentic.loop.timed_out'
  | 'agentic.loop.limit_reached';

/** Severity of an agentic event. */
export type AgenticEventSeverity = 'info' | 'warning' | 'error';

/** Safe metadata about an agentic event. No payload/secret content. */
export interface AgenticEventMetadata {
  readonly agentId?: string;
  readonly executionId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly turn?: number;
  readonly decisionType?: string;
  readonly tool?: string;
  readonly toolCallId?: string;
  readonly toolCallStatus?: string;
  readonly reasonCode?: string;
  readonly errorCode?: string;
  readonly rejectionCode?: string;
  readonly durationMs?: number;
  readonly reasoningLatencyMs?: number;
  readonly flattenTurns?: number;
  readonly flattenToolCalls?: number;
}

/** A single agentic event before id/sequence are resolved. */
export interface AgenticEvent {
  readonly eventId?: string;
  readonly type: AgenticEventType;
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly success?: boolean;
  readonly metadata?: AgenticEventMetadata;
}

/** A fully resolved, immutable stored agentic event. */
export interface StoredAgenticEvent {
  readonly eventId: string;
  readonly type: AgenticEventType;
  readonly category: AgenticEventCategory;
  readonly severity: AgenticEventSeverity;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly traceId?: string;
  readonly success?: boolean;
  readonly metadata?: AgenticEventMetadata;
}

/** Option for the agentic event log. */
export interface AgenticEventLogOptions {
  readonly maxPageSize?: number;
  readonly eventIdFactory?: () => string;
}

/** Query filter for the agentic event log. */
export interface AgenticEventFilter {
  readonly type?: AgenticEventType;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly success?: boolean;
  readonly category?: AgenticEventCategory;
}

/** Query input for the agentic event log. */
export interface AgenticEventQuery extends AgenticEventFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly maxPageSize?: number;
}

/** Page of agentic events. */
export interface AgenticEventPage {
  readonly items: readonly StoredAgenticEvent[];
  readonly hasMore: boolean;
  readonly total: number;
  readonly pageSize: number;
}

/** Category assigned to a type. */
export function agenticCategoryForType(type: AgenticEventType): AgenticEventCategory {
  if (type === 'agentic.operation.started') {
    return 'operation';
  }
  if (type.startsWith('agentic.reasoning')) {
    return 'reasoning';
  }
  if (type.startsWith('agentic.tool')) {
    return 'tool';
  }
  return 'outcome';
}

/** Severity assigned to a type. */
export function agenticSeverityForType(type: AgenticEventType): AgenticEventSeverity {
  switch (type) {
    case 'agentic.loop.failed':
    case 'agentic.loop.timed_out':
    case 'agentic.tool.failed':
    case 'agentic.reasoning.completed':
      return 'error';
    case 'agentic.loop.cancelled':
    case 'agentic.tool.rejected':
      return 'warning';
    default:
      return 'info';
  }
}

function defaultEventIdFactory(): string {
  return `aev_${randomId()}`;
}

/** Bounded random suffix (avoids requiring node crypto in the hot path). */
function randomId(): string {
  if (typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Deterministic, append-only agentic event log. */
export class AgenticEventLog {
  readonly name = 'agentic-event-log';
  readonly backend = 'in-memory';

  private readonly maxPageSize: number;
  private readonly eventIdFactory: () => string;
  private readonly stored: StoredAgenticEvent[] = [];
  private readonly byId = new Map<string, StoredAgenticEvent>();
  private nextSequence = 0;

  constructor(options: AgenticEventLogOptions = {}) {
    this.maxPageSize = options.maxPageSize ?? 50;
    this.eventIdFactory = options.eventIdFactory ?? defaultEventIdFactory;
  }

  append(event: AgenticEvent): StoredAgenticEvent {
    if (!event.type || !event.occurredAt) {
      throw new Error('Agentic event missing required fields');
    }
    const eventId = event.eventId ?? this.eventIdFactory();
    if (this.byId.has(eventId)) {
      throw new Error(`Duplicate agentic event id: ${eventId}`, { cause: eventId });
    }
    const stored: StoredAgenticEvent = {
      eventId,
      type: event.type,
      category: agenticCategoryForType(event.type),
      severity: agenticSeverityForType(event.type),
      occurredAt: event.occurredAt,
      sequence: this.nextSequence,
      traceId: event.traceId,
      success: event.success,
      metadata: event.metadata,
    };
    this.stored.push(stored);
    this.byId.set(eventId, stored);
    this.nextSequence += 1;
    return stored;
  }

  getById(eventId: string): StoredAgenticEvent | undefined {
    return this.byId.get(eventId);
  }

  query(query: AgenticEventQuery): AgenticEventPage {
    const limit = Math.max(1, Math.min(query.limit ?? this.maxPageSize, this.maxPageSize));
    const matched = this.stored.filter((event) => matches(event, query));
    const total = matched.length;
    let start = 0;
    if (query.cursor !== undefined) {
      const idx = matched.findIndex((e) => e.eventId === query.cursor);
      if (idx >= 0) {
        start = idx + 1;
      }
    }
    const items = matched.slice(start, start + limit);
    return { items, hasMore: start + limit < total, total, pageSize: items.length };
  }

  count(filter?: AgenticEventFilter): number {
    if (filter === undefined) {
      return this.stored.length;
    }
    return this.stored.filter((event) => matches(event, filter)).length;
  }

  latest(limit?: number): readonly StoredAgenticEvent[] {
    const resolved = Math.max(1, Math.min(limit ?? this.maxPageSize, this.maxPageSize));
    return this.stored.slice(Math.max(0, this.stored.length - resolved)).reverse();
  }

  clear(): void {
    this.stored.length = 0;
    this.byId.clear();
    this.nextSequence = 0;
  }
}

function matches(event: StoredAgenticEvent, filter: AgenticEventFilter): boolean {
  if (filter.type !== undefined && event.type !== filter.type) {
    return false;
  }
  if (filter.traceId !== undefined && event.traceId !== filter.traceId) {
    return false;
  }
  if (
    filter.correlationId !== undefined &&
    event.metadata?.correlationId !== filter.correlationId
  ) {
    return false;
  }
  if (filter.success !== undefined && event.success !== filter.success) {
    return false;
  }
  if (filter.category !== undefined && event.category !== filter.category) {
    return false;
  }
  return true;
}

/** Convenience factory. */
export function createAgenticEventLog(options: AgenticEventLogOptions = {}): AgenticEventLog {
  return new AgenticEventLog(options);
}

/** Record: operation started. */
export function operationStartedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly agentId?: string;
  readonly executionId?: string;
  readonly requestId?: string;
}): AgenticEvent {
  return {
    type: 'agentic.operation.started',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    metadata: {
      agentId: input.agentId,
      executionId: input.executionId,
      requestId: input.requestId,
      correlationId: input.correlationId,
    },
  };
}

/** Record: reasoning turn started. */
export function reasoningStartedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly turn: number;
}): AgenticEvent {
  return {
    type: 'agentic.reasoning.started',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    metadata: { correlationId: input.correlationId, turn: input.turn },
  };
}

/** Record: reasoning turn completed (decision type only, never content). */
export function reasoningCompletedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly turn: number;
  readonly decisionType: string;
  readonly reasoningLatencyMs?: number;
  readonly errorCode?: string;
}): AgenticEvent {
  return {
    type: 'agentic.reasoning.completed',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: input.errorCode === undefined,
    metadata: {
      turn: input.turn,
      decisionType: input.decisionType,
      reasoningLatencyMs: input.reasoningLatencyMs,
      errorCode: input.errorCode,
      correlationId: input.correlationId,
    },
  };
}

/** Record: a tool call was requested by the model decision. */
export function toolRequestedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly tool: string;
  readonly toolCallId: string;
  readonly turn: number;
}): AgenticEvent {
  return {
    type: 'agentic.tool.requested',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    metadata: { tool: input.tool, toolCallId: input.toolCallId, turn: input.turn },
  };
}

/** Record: the requested tool was authorized for execution. */
export function toolAuthorizedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly tool: string;
  readonly toolCallId: string;
  readonly turn: number;
}): AgenticEvent {
  return {
    type: 'agentic.tool.authorized',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: true,
    metadata: { tool: input.tool, toolCallId: input.toolCallId, turn: input.turn },
  };
}

/** Record: the requested tool was rejected (safe code only). */
export function toolRejectedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly tool: string;
  readonly toolCallId: string;
  readonly turn: number;
  readonly rejectionCode: string;
}): AgenticEvent {
  return {
    type: 'agentic.tool.rejected',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: false,
    metadata: {
      tool: input.tool,
      toolCallId: input.toolCallId,
      turn: input.turn,
      rejectionCode: input.rejectionCode,
    },
  };
}

/** Record: tool execution started through AG-004. */
export function toolStartedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly tool: string;
  readonly toolCallId: string;
  readonly turn: number;
}): AgenticEvent {
  return {
    type: 'agentic.tool.started',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    metadata: { tool: input.tool, toolCallId: input.toolCallId, turn: input.turn },
  };
}

/** Record: tool execution completed (status only). */
export function toolCompletedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly tool: string;
  readonly toolCallId: string;
  readonly turn: number;
  readonly toolCallStatus: string;
  readonly durationMs?: number;
}): AgenticEvent {
  return {
    type: 'agentic.tool.completed',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: true,
    metadata: {
      tool: input.tool,
      toolCallId: input.toolCallId,
      turn: input.turn,
      toolCallStatus: input.toolCallStatus,
      durationMs: input.durationMs,
    },
  };
}

/** Record: tool execution failed. */
export function toolFailedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly tool: string;
  readonly toolCallId: string;
  readonly turn: number;
  readonly errorCode?: string;
}): AgenticEvent {
  return {
    type: 'agentic.tool.failed',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: false,
    metadata: {
      tool: input.tool,
      toolCallId: input.toolCallId,
      turn: input.turn,
      errorCode: input.errorCode,
    },
  };
}

/** Record: loop completed normally. */
export function loopCompletedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly turns: number;
}): AgenticEvent {
  return {
    type: 'agentic.loop.completed',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: true,
    metadata: { correlationId: input.correlationId, flattenTurns: input.turns },
  };
}

/** Record: loop failed. */
export function loopFailedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly errorCode: string;
}): AgenticEvent {
  return {
    type: 'agentic.loop.failed',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: false,
    metadata: { correlationId: input.correlationId, errorCode: input.errorCode },
  };
}

/** Record: loop cancelled. */
export function loopCancelledEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly correlationId?: string;
}): AgenticEvent {
  return {
    type: 'agentic.loop.cancelled',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: false,
    metadata: { correlationId: input.correlationId },
  };
}

/** Record: loop timed out. */
export function loopTimedOutEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly correlationId?: string;
}): AgenticEvent {
  return {
    type: 'agentic.loop.timed_out',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: false,
    metadata: { correlationId: input.correlationId },
  };
}

/** Record: loop reached a configured limit. */
export function loopLimitReachedEvent(input: {
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly reasonCode: string;
}): AgenticEvent {
  return {
    type: 'agentic.loop.limit_reached',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: false,
    metadata: { correlationId: input.correlationId, reasonCode: input.reasonCode },
  };
}
