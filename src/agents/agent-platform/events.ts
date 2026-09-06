/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. Observable event trail.
 *
 * Safe, append-only audit of platform lifecycle and policy decisions. Events
 * never carry secrets, credentials, database URLs, private prompts, or
 * chain-of-thought — only identifiers, lifecycle state, mode, capability,
 * permission, tool, and reason codes.
 */

/** Categories of platform events. */
export type AgentPlatformEventCategory = 'lifecycle' | 'policy';

/** Typed platform event kinds. */
export type AgentPlatformEventType =
  | 'agent.registered'
  | 'agent.initializing'
  | 'agent.ready'
  | 'agent.started'
  | 'agent.paused'
  | 'agent.resumed'
  | 'agent.draining'
  | 'agent.disabled'
  | 'agent.failed'
  | 'agent.recovered'
  | 'agent.terminated'
  | 'agent.execution.denied'
  | 'agent.capability.denied'
  | 'agent.permission.denied'
  | 'agent.tool.denied';

/** Severity of a platform event. */
export type AgentPlatformEventSeverity = 'info' | 'warning' | 'error';

/** Safe metadata for a platform event. No payload/secret content. */
export interface AgentPlatformEventMetadata {
  readonly agentId?: string;
  readonly version?: string;
  readonly lifecycleState?: string;
  readonly previousState?: string;
  readonly capability?: string;
  readonly executionMode?: string;
  readonly permission?: string;
  readonly tool?: string;
  readonly reasonCode?: string;
  readonly executionId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

/** A single platform event before id/sequence resolution. */
export interface AgentPlatformEvent {
  readonly eventId?: string;
  readonly type: AgentPlatformEventType;
  readonly occurredAt: string;
  readonly success?: boolean;
  readonly metadata?: AgentPlatformEventMetadata;
}

/** A fully resolved, immutable stored platform event. */
export interface StoredAgentPlatformEvent {
  readonly eventId: string;
  readonly type: AgentPlatformEventType;
  readonly category: AgentPlatformEventCategory;
  readonly severity: AgentPlatformEventSeverity;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly success?: boolean;
  readonly metadata?: AgentPlatformEventMetadata;
}

/** Options for the platform event log. */
export interface AgentPlatformEventLogOptions {
  readonly maxPageSize?: number;
  readonly eventIdFactory?: () => string;
}

/** Query filter for the event log. */
export interface AgentPlatformEventFilter {
  readonly type?: AgentPlatformEventType;
  readonly category?: AgentPlatformEventCategory;
  readonly agentId?: string;
  readonly success?: boolean;
}

/** Query input for the event log. */
export interface AgentPlatformEventQuery extends AgentPlatformEventFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly maxPageSize?: number;
}

/** Page of stored platform events. */
export interface AgentPlatformEventPage {
  readonly items: readonly StoredAgentPlatformEvent[];
  readonly hasMore: boolean;
  readonly total: number;
  readonly pageSize: number;
}

/** Category assigned to a type. */
export function platformCategoryForType(type: AgentPlatformEventType): AgentPlatformEventCategory {
  return type.endsWith('.denied') ? 'policy' : 'lifecycle';
}

/** Severity assigned to a type. */
export function platformSeverityForType(type: AgentPlatformEventType): AgentPlatformEventSeverity {
  switch (type) {
    case 'agent.failed':
    case 'agent.capability.denied':
    case 'agent.permission.denied':
    case 'agent.tool.denied':
      return 'error';
    case 'agent.disabled':
    case 'agent.terminated':
    case 'agent.execution.denied':
      return 'warning';
    default:
      return 'info';
  }
}

function defaultEventIdFactory(): string {
  return `apv_${randomId()}`;
}

/** Bounded random suffix (avoids requiring node crypto in the hot path). */
function randomId(): string {
  if (typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Deterministic, append-only agent platform event log. */
export class AgentPlatformEventLog {
  readonly name = 'agent-platform-event-log';
  readonly backend = 'in-memory';

  private readonly maxPageSize: number;
  private readonly eventIdFactory: () => string;
  private readonly stored: StoredAgentPlatformEvent[] = [];
  private readonly byId = new Map<string, StoredAgentPlatformEvent>();
  private nextSequence = 0;

  constructor(options: AgentPlatformEventLogOptions = {}) {
    this.maxPageSize = options.maxPageSize ?? 50;
    this.eventIdFactory = options.eventIdFactory ?? defaultEventIdFactory;
  }

  append(event: AgentPlatformEvent): StoredAgentPlatformEvent {
    if (!event.type || !event.occurredAt) {
      throw new Error('Agent platform event missing required fields');
    }
    const eventId = event.eventId ?? this.eventIdFactory();
    if (this.byId.has(eventId)) {
      throw new Error(`Duplicate agent platform event id: ${eventId}`, { cause: eventId });
    }
    const stored: StoredAgentPlatformEvent = {
      eventId,
      type: event.type,
      category: platformCategoryForType(event.type),
      severity: platformSeverityForType(event.type),
      occurredAt: event.occurredAt,
      sequence: this.nextSequence,
      success: event.success,
      metadata: event.metadata,
    };
    this.stored.push(stored);
    this.byId.set(eventId, stored);
    this.nextSequence += 1;
    return stored;
  }

  getById(eventId: string): StoredAgentPlatformEvent | undefined {
    return this.byId.get(eventId);
  }

  query(query: AgentPlatformEventQuery): AgentPlatformEventPage {
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

  count(filter?: AgentPlatformEventFilter): number {
    if (filter === undefined) {
      return this.stored.length;
    }
    return this.stored.filter((event) => matches(event, filter)).length;
  }

  latest(limit?: number): readonly StoredAgentPlatformEvent[] {
    const resolved = Math.max(1, Math.min(limit ?? this.maxPageSize, this.maxPageSize));
    return this.stored.slice(Math.max(0, this.stored.length - resolved)).reverse();
  }

  clear(): void {
    this.stored.length = 0;
    this.byId.clear();
    this.nextSequence = 0;
  }
}

function matches(event: StoredAgentPlatformEvent, filter: AgentPlatformEventFilter): boolean {
  if (filter.type !== undefined && event.type !== filter.type) {
    return false;
  }
  if (filter.category !== undefined && event.category !== filter.category) {
    return false;
  }
  if (filter.agentId !== undefined && event.metadata?.agentId !== filter.agentId) {
    return false;
  }
  if (filter.success !== undefined && event.success !== filter.success) {
    return false;
  }
  return true;
}

/** Convenience factory. */
export function createAgentPlatformEventLog(
  options: AgentPlatformEventLogOptions = {},
): AgentPlatformEventLog {
  return new AgentPlatformEventLog(options);
}

/** Base builder for a platform event with safe metadata. */
type EventInput = {
  readonly occurredAt: string;
  readonly agentId?: string;
  readonly version?: string;
  readonly lifecycleState?: string;
  readonly previousState?: string;
  readonly capability?: string;
  readonly executionMode?: string;
  readonly permission?: string;
  readonly tool?: string;
  readonly reasonCode?: string;
  readonly executionId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
};

function eventFor(
  type: AgentPlatformEventType,
  input: EventInput,
  success?: boolean,
): AgentPlatformEvent {
  const metadata: AgentPlatformEventMetadata = {
    agentId: input.agentId,
    version: input.version,
    lifecycleState: input.lifecycleState,
    previousState: input.previousState,
    capability: input.capability,
    executionMode: input.executionMode,
    permission: input.permission,
    tool: input.tool,
    reasonCode: input.reasonCode,
    executionId: input.executionId,
    requestId: input.requestId,
    correlationId: input.correlationId,
  };
  const clean: {
    -readonly [K in keyof AgentPlatformEventMetadata]?: AgentPlatformEventMetadata[K];
  } = {};
  for (const key of Object.keys(metadata) as (keyof AgentPlatformEventMetadata)[]) {
    const value = metadata[key];
    if (value !== undefined) {
      clean[key] = value;
    }
  }
  return { type, occurredAt: input.occurredAt, success, metadata: clean };
}

/** Record: agent definition registered. */
export function agentRegisteredEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.registered', input, true);
}

/** Record: agent entering initialization. */
export function agentInitializingEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.initializing', input);
}

/** Record: agent became ready (or returned to ready after completion). */
export function agentReadyEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.ready', input, true);
}

/** Record: an execution started against the agent (entering RUNNING). */
export function agentStartedEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.started', input, true);
}

/** Record: agent paused. */
export function agentPausedEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.paused', input);
}

/** Record: agent resumed. */
export function agentResumedEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.resumed', input, true);
}

/** Record: agent draining. */
export function agentDrainingEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.draining', input);
}

/** Record: agent disabled. */
export function agentDisabledEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.disabled', input);
}

/** Record: agent marked failed. */
export function agentFailedEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.failed', input, false);
}

/** Record: agent recovered from a failed/disabled state. */
export function agentRecoveredEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.recovered', input, true);
}

/** Record: agent terminated. */
export function agentTerminatedEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.terminated', input);
}

/** Record: an execution was rejected (lifecycle / limit). */
export function executionDeniedEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.execution.denied', input, false);
}

/** Record: a capability/execution-mode denial. */
export function capabilityDeniedEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.capability.denied', input, false);
}

/** Record: a permission denial. */
export function permissionDeniedEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.permission.denied', input, false);
}

/** Record: a tool allowlist denial. */
export function toolDeniedEvent(input: EventInput): AgentPlatformEvent {
  return eventFor('agent.tool.denied', input, false);
}
