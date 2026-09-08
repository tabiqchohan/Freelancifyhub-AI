/**
 * Sprint 21 — Client AI Team v1. Observable events (§25).
 *
 * Safe, append-only audit of client-AI request lifecycle: selection, memory/
 * knowledge access, tool use, and terminal outcomes. Events never carry
 * secrets, database URLs, prompts, chain-of-thought, or raw payloads — only
 * identifiers, statuses and reason codes.
 */

/** Typed client-AI event kinds (Sprint 21 §25). */
export type ClientAIEventType =
  | 'CLIENT_WORKFLOW_SELECTED'
  | 'CLIENT_WORKFLOW_STARTED'
  | 'CLIENT_WORKFLOW_COMPLETED'
  | 'CLIENT_WORKFLOW_FAILED'
  | 'CLIENT_WORKFLOW_CANCELLED'
  | 'CLIENT_WORKFLOW_TIMEOUT'
  | 'CLIENT_AGENT_STARTED'
  | 'CLIENT_AGENT_COMPLETED'
  | 'CLIENT_AGENT_FAILED'
  | 'CLIENT_AGENT_SKIPPED'
  | 'CLIENT_RECOMMENDATION_GENERATED'
  | 'CLIENT_MEMORY_ACCESSED'
  | 'CLIENT_KNOWLEDGE_ACCESSED'
  | 'CLIENT_TOOL_USED';

/** Severity of a client-AI event. */
export type ClientAIEventSeverity = 'info' | 'warning' | 'error';

/** Safe metadata attached to a client-AI event (never payloads). */
export interface ClientAIEventMetadata {
  readonly clientRequestId?: string;
  readonly correlationId?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly agentId?: string;
  readonly capabilityId?: string;
  readonly taskId?: string;
  readonly workflowId?: string;
  readonly coordinationId?: string;
  readonly status?: string;
  readonly reasonCode?: string;
  readonly routeKind?: string;
  readonly intent?: string;
  readonly count?: number;
}

/** A client-AI event before identity/sequence resolution. */
export interface ClientAIEventInput {
  readonly type: ClientAIEventType;
  readonly occurredAt: string;
  readonly success?: boolean;
  readonly metadata?: ClientAIEventMetadata;
}

/** A fully resolved, immutable stored client-AI event. */
export interface StoredClientAIEvent {
  readonly eventId: string;
  readonly type: ClientAIEventType;
  readonly category: 'client';
  readonly severity: ClientAIEventSeverity;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly success?: boolean;
  readonly metadata?: ClientAIEventMetadata;
}

/** Options for the client-AI event log. */
export interface ClientAIEventLogOptions {
  readonly eventIdFactory?: () => string;
}

/** The client-AI event log (append-only, deterministic ordering). */
export class ClientAIEventLog {
  readonly name = 'client-ai-event-log';

  private readonly events: StoredClientAIEvent[] = [];
  private readonly eventIdFactory: () => string;

  constructor(options: ClientAIEventLogOptions = {}) {
    this.eventIdFactory = options.eventIdFactory ?? (() => `evt_client_${this.events.length + 1}`);
  }

  /** Appends a resolved event and returns it. */
  append(input: ClientAIEventInput): StoredClientAIEvent {
    const event: StoredClientAIEvent = {
      eventId: this.eventIdFactory(),
      type: input.type,
      category: 'client',
      severity: severityFor(input),
      occurredAt: input.occurredAt,
      sequence: this.events.length + 1,
      success: input.success,
      metadata: input.metadata,
    };
    this.events.push(event);
    return event;
  }

  /** All stored events, in append order. */
  query(): readonly StoredClientAIEvent[] {
    return Object.freeze([...this.events]);
  }

  /** Number of stored events. */
  count(): number {
    return this.events.length;
  }

  /** Most recent stored event (undefined when empty). */
  latest(): StoredClientAIEvent | undefined {
    return this.events.length > 0 ? this.events[this.events.length - 1] : undefined;
  }

  /** Events of a single type, in append order. */
  ofType(type: ClientAIEventType): readonly StoredClientAIEvent[] {
    return Object.freeze(this.events.filter((event) => event.type === type));
  }
}

function severityFor(input: ClientAIEventInput): ClientAIEventSeverity {
  if (input.success === false) {
    return 'error';
  }
  if (input.type === 'CLIENT_WORKFLOW_CANCELLED' || input.type === 'CLIENT_WORKFLOW_TIMEOUT') {
    return 'warning';
  }
  return 'info';
}
